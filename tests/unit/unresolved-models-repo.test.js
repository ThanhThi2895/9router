import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-unresolved-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("unresolvedModelsRepo", () => {
  it("aggregates repeated events with the same key and increments count", async () => {
    const {
      recordUnresolvedModelEvent,
      flushUnresolvedModels,
      getUnresolvedModels,
    } = await import("@/lib/db/repos/unresolvedModelsRepo.js");

    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: "non-existent-model",
      reason: "no_credentials",
      provider: "openai",
      error: "Error 1",
    });

    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: "non-existent-model",
      reason: "no_credentials",
      provider: "openai",
      error: "Error 2",
    });

    await flushUnresolvedModels();

    const result = await getUnresolvedModels();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].count).toBe(2);
    expect(result.items[0].requestedModel).toBe("non-existent-model");
    expect(result.items[0].reason).toBe("no_credentials");
    expect(result.items[0].lastError).toBe("Error 2");
    expect(result.items[0].resolved).toBe(false);
  });

  it("truncates oversized fields", async () => {
    const {
      recordUnresolvedModelEvent,
      flushUnresolvedModels,
      getUnresolvedModels,
    } = await import("@/lib/db/repos/unresolvedModelsRepo.js");

    const longModel = "m".repeat(300);
    const longError = "e".repeat(700);
    const longUa = "u".repeat(300);

    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: longModel,
      reason: "missing_model",
      error: longError,
      userAgent: longUa,
    });

    await flushUnresolvedModels();

    const result = await getUnresolvedModels();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].requestedModel.length).toBe(200);
    expect(result.items[0].lastError.length).toBe(500);
    expect(result.items[0].lastUserAgent.length).toBe(200);
  });

  it("marks resolved and re-activates when hit again", async () => {
    const {
      recordUnresolvedModelEvent,
      flushUnresolvedModels,
      getUnresolvedModels,
      setUnresolvedModelResolved,
    } = await import("@/lib/db/repos/unresolvedModelsRepo.js");

    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: "test-model",
      reason: "no_credentials",
    });
    await flushUnresolvedModels();

    let res = await getUnresolvedModels();
    const id = res.items[0].id;
    expect(res.items[0].resolved).toBe(false);

    await setUnresolvedModelResolved(id, true);

    // Default query hides resolved
    res = await getUnresolvedModels({ includeResolved: false });
    expect(res.items).toHaveLength(0);

    // includeResolved shows it
    res = await getUnresolvedModels({ includeResolved: true });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].resolved).toBe(true);

    // Hit again flips resolved back to false
    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: "test-model",
      reason: "no_credentials",
    });
    await flushUnresolvedModels();

    res = await getUnresolvedModels({ includeResolved: false });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].count).toBe(2);
    expect(res.items[0].resolved).toBe(false);
  });

  it("enforces cap at 500 by evicting oldest lastSeen", async () => {
    const {
      recordUnresolvedModelEvent,
      flushUnresolvedModels,
      getUnresolvedModels,
    } = await import("@/lib/db/repos/unresolvedModelsRepo.js");

    // Insert 505 unique events
    for (let i = 0; i < 505; i++) {
      recordUnresolvedModelEvent({
        endpoint: "/v1/chat/completions",
        requestedModel: `model-${String(i).padStart(4, "0")}`,
        reason: "no_credentials",
      });
    }

    await flushUnresolvedModels();

    const res = await getUnresolvedModels({ pageSize: 100 });
    expect(res.pagination.totalItems).toBe(500);
  });
});
