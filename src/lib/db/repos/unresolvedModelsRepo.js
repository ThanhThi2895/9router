import crypto from "node:crypto";
import { getAdapter } from "../driver.js";

const DEFAULT_MAX_RECORDS = 500;
const FLUSH_INTERVAL_MS = 5000;
const BATCH_SIZE = 50;

function sanitizeString(val, maxLen) {
  if (val === null || val === undefined) return null;
  const str = typeof val === "string" ? val : String(val);
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function computeEventId(endpoint, requestedModel, reason) {
  const normEndpoint = endpoint || "";
  const normModel = requestedModel || "";
  const normReason = reason || "";
  return crypto
    .createHash("sha1")
    .update(`${normEndpoint}|${normModel}|${normReason}`)
    .digest("hex");
}

const pendingEvents = new Map();
let flushTimer = null;
let flushPromise = null;

async function _doFlush() {
  const db = await getAdapter();
  while (pendingEvents.size > 0) {
    const items = Array.from(pendingEvents.values());
    pendingEvents.clear();

    db.transaction(() => {
      for (const item of items) {
        db.run(
          `INSERT INTO unresolvedModels (
            id, endpoint, requestedModel, reason, provider, count, firstSeen, lastSeen, lastError, lastUserAgent, resolved
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET
            count = count + excluded.count,
            lastSeen = excluded.lastSeen,
            lastError = excluded.lastError,
            lastUserAgent = excluded.lastUserAgent,
            provider = COALESCE(excluded.provider, unresolvedModels.provider),
            resolved = 0`,
          [
            item.id,
            item.endpoint,
            item.requestedModel,
            item.reason,
            item.provider,
            item.count,
            item.firstSeen,
            item.lastSeen,
            item.lastError,
            item.lastUserAgent,
          ]
        );
      }

      const cnt = db.get(`SELECT COUNT(*) as c FROM unresolvedModels`);
      if (cnt && cnt.c > DEFAULT_MAX_RECORDS) {
        db.run(
          `DELETE FROM unresolvedModels WHERE id IN (
            SELECT id FROM unresolvedModels ORDER BY lastSeen ASC LIMIT ?
          )`,
          [cnt.c - DEFAULT_MAX_RECORDS]
        );
      }
    });
  }
}

export async function flushUnresolvedModels() {
  while (flushPromise) {
    await flushPromise;
  }
  if (pendingEvents.size === 0) return;
  flushPromise = _doFlush();
  try {
    await flushPromise;
  } catch (e) {
    console.error("[unresolvedModelsRepo] Batch write failed:", e);
  } finally {
    flushPromise = null;
  }
}

export function recordUnresolvedModelEvent(event = {}) {
  try {
    const endpoint = sanitizeString(event.endpoint || "", 200);
    const requestedModel = sanitizeString(event.requestedModel ?? "", 200);
    const reason = sanitizeString(event.reason || "unknown", 50);
    const provider = sanitizeString(event.provider, 100);
    const error = sanitizeString(event.error, 500);
    const userAgent = sanitizeString(event.userAgent, 200);

    const id = computeEventId(endpoint, requestedModel, reason);
    const now = new Date().toISOString();

    const existing = pendingEvents.get(id);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      if (error) existing.lastError = error;
      if (userAgent) existing.lastUserAgent = userAgent;
      if (provider) existing.provider = provider;
    } else {
      pendingEvents.set(id, {
        id,
        endpoint,
        requestedModel,
        reason,
        provider: provider || null,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        lastError: error || null,
        lastUserAgent: userAgent || null,
      });
    }

    if (pendingEvents.size >= BATCH_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushUnresolvedModels().catch((e) => console.error("[unresolvedModelsRepo] flush err:", e));
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushUnresolvedModels().catch(() => {});
      }, FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    // Fail-open
    console.error("[unresolvedModelsRepo] recordUnresolvedModelEvent error:", err);
  }
}

export async function getUnresolvedModels(filter = {}) {
  if (pendingEvents.size > 0) {
    await flushUnresolvedModels();
  }
  const db = await getAdapter();
  const conds = [];
  const params = [];

  const includeResolved =
    filter.includeResolved === true ||
    filter.includeResolved === "true" ||
    filter.includeResolved === 1 ||
    filter.includeResolved === "1";
  if (!includeResolved) {
    conds.push("resolved = 0");
  }

  if (filter.reason) {
    conds.push("reason = ?");
    params.push(filter.reason);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM unresolvedModels ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = Math.max(1, parseInt(filter.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(filter.pageSize, 10) || 50));
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT id, endpoint, requestedModel, reason, provider, count, firstSeen, lastSeen, lastError, lastUserAgent, resolved
     FROM unresolvedModels ${where} ORDER BY lastSeen DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return {
    items: rows.map((r) => ({ ...r, resolved: r.resolved === 1 })),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

export async function setUnresolvedModelResolved(id, resolved = true) {
  if (pendingEvents.size > 0) {
    await flushUnresolvedModels();
  }
  const db = await getAdapter();
  db.run(`UPDATE unresolvedModels SET resolved = ? WHERE id = ?`, [resolved ? 1 : 0, id]);
}

export async function deleteUnresolvedModel(id) {
  if (pendingEvents.has(id)) {
    pendingEvents.delete(id);
  }
  const db = await getAdapter();
  db.run(`DELETE FROM unresolvedModels WHERE id = ?`, [id]);
}

export async function clearUnresolvedModels() {
  pendingEvents.clear();
  const db = await getAdapter();
  db.run(`DELETE FROM unresolvedModels`);
}

const _shutdownHandler = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingEvents.size > 0) await flushUnresolvedModels();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();

export const __test__ = {
  sanitizeString,
  computeEventId,
  pendingEvents,
  DEFAULT_MAX_RECORDS,
};
