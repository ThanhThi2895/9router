import { describe, it, expect, vi, afterEach } from "vitest";
import { withSseKeepalive } from "../../open-sse/utils/sseKeepalive.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sseResponse = (stream) => new Response(stream, { headers: { "Content-Type": "text/event-stream" } });

function controlled() {
  let ctl;
  const stream = new ReadableStream({ start(c) { ctl = c; } });
  return { stream, push: (s) => ctl.enqueue(enc.encode(s)), close: () => ctl.close() };
}

async function drain(response) {
  const reader = response.body.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}

afterEach(() => vi.useRealTimers());

describe("withSseKeepalive", () => {
  it("returns 200 SSE headers and an initial ping before the inner result resolves", async () => {
    const res = withSseKeepalive(new Promise(() => {}), { intervalMs: 15000 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const { value } = await res.body.getReader().read();
    expect(dec.decode(value)).toBe(": ping\n\n");
  });

  it("pings about every interval while waiting, then forwards the stream unchanged", async () => {
    vi.useFakeTimers();
    let resolve;
    const inner = new Promise((r) => { resolve = r; });
    const res = withSseKeepalive(inner, { intervalMs: 15000 });
    const done = drain(res);

    await vi.advanceTimersByTimeAsync(46000);
    const up = controlled();
    resolve(sseResponse(up.stream));
    up.push('data: {"a":1}\n\n');
    up.push("data: [DONE]\n\n");
    up.close();
    const out = await done;

    const pings = out.split(": ping\n\n").length - 1;
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(out.endsWith('data: {"a":1}\n\ndata: [DONE]\n\n')).toBe(true);
  });

  it("pings during a long silent gap after the first chunk", async () => {
    vi.useFakeTimers();
    const up = controlled();
    const res = withSseKeepalive(Promise.resolve(sseResponse(up.stream)), { intervalMs: 15000 });
    const done = drain(res);
    await vi.advanceTimersByTimeAsync(0);
    up.push('data: {"a":1}\n\n');
    await vi.advanceTimersByTimeAsync(31000);
    up.push('data: {"a":2}\n\n');
    up.close();
    const out = await done;
    const between = out.slice(out.indexOf('{"a":1}'), out.indexOf('{"a":2}'));
    expect(between).toContain(": ping\n\n");
  });

  it("never injects a ping inside a partially delivered event", async () => {
    vi.useFakeTimers();
    const up = controlled();
    const res = withSseKeepalive(Promise.resolve(sseResponse(up.stream)), { intervalMs: 15000 });
    const done = drain(res);
    await vi.advanceTimersByTimeAsync(0);
    up.push('data: {"par');
    await vi.advanceTimersByTimeAsync(40000);
    up.push('tial":true}\n\n');
    up.close();
    const out = await done;
    expect(out).toContain('data: {"partial":true}\n\n');
  });

  it("turns an error response into an in-stream OpenAI error event", async () => {
    const err = new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 429, headers: { "Content-Type": "application/json" } });
    const out = await drain(withSseKeepalive(Promise.resolve(err), { intervalMs: 15000 }));
    expect(out).toContain("quota exhausted");
    expect(out).toContain("data: [DONE]");
  });

  it("shapes errors as a Claude error event for Claude clients", async () => {
    const out = await drain(withSseKeepalive(Promise.reject(new Error("boom")), { intervalMs: 15000, errorFormat: FORMATS.CLAUDE }));
    expect(out).toContain('"type":"error"');
    expect(out).toContain("boom");
  });

  it("cancels the inner stream when the client disconnects", async () => {
    const cancel = vi.fn();
    const inner = new ReadableStream({ start() {}, cancel });
    const res = withSseKeepalive(Promise.resolve(sseResponse(inner)), { intervalMs: 15000 });
    const reader = res.body.getReader();
    await reader.read(); // initial ping
    await new Promise((r) => setTimeout(r, 0));
    await reader.cancel();
    expect(cancel).toHaveBeenCalled();
  });
});
