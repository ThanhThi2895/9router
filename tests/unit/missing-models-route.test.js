import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data, init = {}) => ({
      status: init.status || 200,
      json: async () => data,
    }),
  },
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-route-test-"));
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

describe("/api/usage/missing-models route", () => {
  it("handles GET, PATCH, and DELETE workflows", async () => {
    const { recordUnresolvedModelEvent, flushUnresolvedModels } = await import(
      "@/lib/db/repos/unresolvedModelsRepo.js"
    );
    const { GET, PATCH, DELETE } = await import(
      "../../src/app/api/usage/missing-models/route.js"
    );

    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: "gpt-nope",
      reason: "missing_model",
      provider: "openai",
    });
    recordUnresolvedModelEvent({
      endpoint: "/v1/chat/completions",
      requestedModel: "claude-fake",
      reason: "no_credentials",
      provider: "anthropic",
    });
    await flushUnresolvedModels();

    // 1. GET all
    let req = new Request("http://localhost:20128/api/usage/missing-models");
    let res = await GET(req);
    expect(res.status).toBe(200);
    let data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.pagination.totalItems).toBe(2);

    // 2. GET with filter
    req = new Request(
      "http://localhost:20128/api/usage/missing-models?reason=missing_model"
    );
    res = await GET(req);
    data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].requestedModel).toBe("gpt-nope");

    // 3. PATCH resolve
    const targetId = data.items[0].id;
    let patchReq = new Request("http://localhost:20128/api/usage/missing-models", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetId, resolved: true }),
    });
    let patchRes = await PATCH(patchReq);
    expect(patchRes.status).toBe(200);

    // Default GET hides resolved
    req = new Request("http://localhost:20128/api/usage/missing-models");
    res = await GET(req);
    data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].requestedModel).toBe("claude-fake");

    // GET with includeResolved=true shows it
    req = new Request(
      "http://localhost:20128/api/usage/missing-models?includeResolved=true"
    );
    res = await GET(req);
    data = await res.json();
    expect(data.items).toHaveLength(2);

    // 4. DELETE single
    let delReq = new Request(
      `http://localhost:20128/api/usage/missing-models?id=${encodeURIComponent(targetId)}`,
      { method: "DELETE" }
    );
    let delRes = await DELETE(delReq);
    expect(delRes.status).toBe(200);

    req = new Request(
      "http://localhost:20128/api/usage/missing-models?includeResolved=true"
    );
    res = await GET(req);
    data = await res.json();
    expect(data.items).toHaveLength(1);

    // 5. DELETE clear all
    delReq = new Request("http://localhost:20128/api/usage/missing-models", {
      method: "DELETE",
    });
    delRes = await DELETE(delReq);
    expect(delRes.status).toBe(200);

    req = new Request(
      "http://localhost:20128/api/usage/missing-models?includeResolved=true"
    );
    res = await GET(req);
    data = await res.json();
    expect(data.items).toHaveLength(0);
  });

  it("validates invalid pagination parameters", async () => {
    const { GET } = await import("../../src/app/api/usage/missing-models/route.js");

    let req = new Request("http://localhost:20128/api/usage/missing-models?page=0");
    let res = await GET(req);
    expect(res.status).toBe(400);

    req = new Request("http://localhost:20128/api/usage/missing-models?pageSize=150");
    res = await GET(req);
    expect(res.status).toBe(400);
  });
});
