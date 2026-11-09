import { SSE_HEADERS_CORS } from "./sseConstants.js";
import { buildStreamErrorBytes } from "./streamHelpers.js";
import { SSE_KEEPALIVE_INTERVAL_MS, SSE_KEEPALIVE_COMMIT_DELAY_MS } from "../config/runtimeConfig.js";

const encoder = new TextEncoder();
const PING = encoder.encode(": ping\n\n");
const LF = 10;
const CR = 13;

/**
 * Hold the real response for a grace window; if it resolves in time, return it
 * unchanged. Otherwise commit SSE status + headers and keep the connection warm
 * with `: ping` comments while the real response is still being produced.
 *
 * Pings are SSE comments (ignored by every SSE parser) and are only written on an
 * event boundary, so they can never land inside a partially delivered event. They
 * cover both the wait before the inner Response exists (upstream prefill) and any
 * long silent gap after it.
 *
 * Only a response slower than the grace window loses its real status: its failure is
 * then delivered as an in-stream error event (shape chosen by `errorFormat`).
 *
 * @param {Promise<Response>} resultPromise - resolves to the real handler response
 * @param {object} [opts]
 * @param {string} [opts.errorFormat] - client format used to shape in-stream errors
 * @param {number} [opts.intervalMs] - idle gap before a ping (default SSE_KEEPALIVE_INTERVAL_MS)
 * @param {number} [opts.commitDelayMs] - grace window before committing (default SSE_KEEPALIVE_COMMIT_DELAY_MS)
 * @returns {Promise<Response>}
 */
export async function withSseKeepalive(resultPromise, { errorFormat, intervalMs = SSE_KEEPALIVE_INTERVAL_MS, commitDelayMs = SSE_KEEPALIVE_COMMIT_DELAY_MS } = {}) {
  const PENDING = Symbol("pending");
  let graceTimer;
  const grace = new Promise((resolve) => { graceTimer = setTimeout(() => resolve(PENDING), commitDelayMs); });
  let settled;
  try {
    settled = await Promise.race([resultPromise, grace]);
  } finally {
    clearTimeout(graceTimer);
  }
  if (settled !== PENDING) return settled;
  return commitSse(resultPromise, { errorFormat, intervalMs });
}

/** Commit immediately (no grace window). Exported for stream-mechanics tests. */
export function commitSse(resultPromise, { errorFormat, intervalMs }) {
  let timer = null;
  let cancelled = false;
  let reader = null;
  let lateBody = null;

  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  const body = new ReadableStream({
    async start(controller) {
      let lastWriteAt = Date.now();
      let tail = [LF, LF]; // last bytes written; starts on an event boundary
      const atBoundary = () => {
        const n = tail.length;
        if (n >= 2 && tail[n - 1] === LF && tail[n - 2] === LF) return true;
        return n >= 4 && tail[n - 1] === LF && tail[n - 2] === CR && tail[n - 3] === LF && tail[n - 4] === CR;
      };
      const write = (bytes) => {
        if (cancelled) return;
        try { controller.enqueue(bytes); } catch { cancelled = true; return; }
        lastWriteAt = Date.now();
        tail = tail.concat(Array.from(bytes.subarray(Math.max(0, bytes.length - 4)))).slice(-4);
      };
      const finish = () => {
        stopTimer();
        if (!cancelled) { try { controller.close(); } catch { /* already closed */ } }
      };

      // Flushes status + headers through the proxy chain right away.
      write(PING);
      if (intervalMs > 0) {
        timer = setInterval(() => {
          if (Date.now() - lastWriteAt >= intervalMs && atBoundary()) write(PING);
        }, Math.max(10, Math.floor(intervalMs / 3)));
      }

      let response;
      try {
        response = await resultPromise;
      } catch (e) {
        write(buildStreamErrorBytes(502, e?.message || "Internal error", errorFormat));
        return finish();
      }
      if (cancelled) { response?.body?.cancel?.().catch(() => {}); return finish(); }
      lateBody = response?.body || null;

      const contentType = (response?.headers?.get("content-type") || "").toLowerCase();
      if (!response?.body || !contentType.includes("text/event-stream")) {
        // Error or JSON result that cannot be sent as an HTTP status any more.
        let text = "";
        try { text = response?.body ? await response.text() : ""; } catch { /* empty */ }
        let message = text;
        try { message = JSON.parse(text)?.error?.message || text; } catch { /* raw text */ }
        const status = response?.status || 502;
        write(buildStreamErrorBytes(status >= 400 ? status : 502, message || `Upstream returned ${status}`, errorFormat));
        return finish();
      }

      reader = response.body.getReader();
      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) write(value);
        }
      } catch (e) {
        write(buildStreamErrorBytes(502, e?.message || "Stream error", errorFormat));
      }
      finish();
    },
    cancel(reason) {
      cancelled = true;
      stopTimer();
      if (reader) reader.cancel(reason).catch(() => {});
      else lateBody?.cancel?.(reason).catch(() => {});
    },
  });

  return new Response(body, { status: 200, headers: SSE_HEADERS_CORS });
}
