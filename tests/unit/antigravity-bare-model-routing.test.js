import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb({ enabled = true, connection = { isActive: true } } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ag-bare-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  delete global._dbAdapter;

  const db = await import("@/lib/db/index.js");
  const { getModelInfo } = await import("@/sse/services/model.js");

  if (enabled) await db.updateSettings({ antigravityBareModelRouting: true });
  if (connection) {
    await db.createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name: "ag-test",
      email: "ag@example.test",
      accessToken: "token",
      ...connection,
    });
  }

  return {
    db,
    getModelInfo,
    cleanup() {
      try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
      delete global._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("antigravity bare-model routing", () => {
  let cleanup = () => {};

  afterEach(() => {
    vi.resetModules();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function setup(opts) {
    const ctx = await setupDb(opts);
    cleanup = ctx.cleanup;
    return ctx;
  }

  describe("getModelInfo", () => {
    it("leaves prefix inference alone when the toggle is off", async () => {
      const ctx = await setup({ enabled: false });
      expect((await ctx.getModelInfo("claude-opus-5-5")).provider).toBe("anthropic");
    });

    it("falls back to prefix inference without an Antigravity connection", async () => {
      const ctx = await setup({ connection: null });
      expect((await ctx.getModelInfo("claude-opus-5-5")).provider).toBe("anthropic");
    });

    it("falls back to prefix inference when the only connection is inactive", async () => {
      const ctx = await setup({ connection: { isActive: false } });
      expect((await ctx.getModelInfo("claude-opus-5-5")).provider).toBe("anthropic");
    });

    it("routes a catalog id to Antigravity", async () => {
      const ctx = await setup();
      expect(await ctx.getModelInfo("claude-opus-5-5"))
        .toEqual({ provider: "antigravity", model: "claude-opus-5-5" });
    });

    it("keeps ids outside the Antigravity catalog on prefix inference", async () => {
      const ctx = await setup();
      expect((await ctx.getModelInfo("gemini-3-pro")).provider).toBe("gemini");
    });

    it("lets a combo of the same name win", async () => {
      const ctx = await setup();
      await ctx.db.createCombo({ name: "gemini-3.8-flash", models: ["ag/gemini-3.8-flash"] });
      expect((await ctx.getModelInfo("gemini-3.8-flash")).provider).toBeNull();
    });

    it("lets an explicit alias win", async () => {
      const ctx = await setup();
      await ctx.db.setModelAlias("claude-opus-5-5", "anthropic/claude-opus-5-5");
      expect((await ctx.getModelInfo("claude-opus-5-5")).provider).toBe("anthropic");
    });

    it("limits routing to the connection's enabledModels", async () => {
      const ctx = await setup({
        connection: { isActive: true, providerSpecificData: { enabledModels: ["gemini-3.8-flash"] } },
      });
      expect((await ctx.getModelInfo("claude-opus-5-5")).provider).toBe("anthropic");
      expect(await ctx.getModelInfo("gemini-3.8-flash"))
        .toEqual({ provider: "antigravity", model: "gemini-3.8-flash" });
    });

    it("routes custom Antigravity models", async () => {
      const ctx = await setup();
      await ctx.db.addCustomModel({ providerAlias: "ag", id: "gemini-9-new", type: "llm" });
      expect(await ctx.getModelInfo("gemini-9-new"))
        .toEqual({ provider: "antigravity", model: "gemini-9-new" });
    });

    it("skips models disabled under Antigravity", async () => {
      const ctx = await setup();
      await ctx.db.disableModels("ag", ["claude-opus-5-5"]);
      expect((await ctx.getModelInfo("claude-opus-5-5")).provider).toBe("anthropic");
    });

    it("leaves the explicit ag/ prefix path untouched", async () => {
      const ctx = await setup();
      expect(await ctx.getModelInfo("ag/claude-opus-5-5"))
        .toEqual({ provider: "antigravity", model: "claude-opus-5-5" });
    });
  });

  describe("resolveGeminiModel", () => {
    const high = { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } };

    it("picks the effort variant for a bare Antigravity id", async () => {
      await setup();
      const { resolveGeminiModel } = await import("@/sse/services/geminiModel.js");
      expect(await resolveGeminiModel("gemini-3.8-flash", high))
        .toBe("antigravity/gemini-3.8-flash-high");
    });

    it("returns a combo-named model untouched", async () => {
      const ctx = await setup();
      await ctx.db.createCombo({ name: "gemini-3.8-flash", models: ["ag/gemini-3.8-flash"] });
      const { resolveGeminiModel } = await import("@/sse/services/geminiModel.js");
      expect(await resolveGeminiModel("gemini-3.8-flash", high)).toBe("gemini-3.8-flash");
    });

    it("returns a bare id untouched when the toggle is off", async () => {
      await setup({ enabled: false });
      const { resolveGeminiModel } = await import("@/sse/services/geminiModel.js");
      expect(await resolveGeminiModel("gemini-3.8-flash", high)).toBe("gemini-3.8-flash");
    });
  });

  describe("key access", () => {
    const ctxFor = (allow) => ({ keyId: "k", keyName: "k", allow, _sets: null });

    it("allows a bare id for a key that lists the ag/ model", async () => {
      await setup();
      const { enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
      expect(await enforceKeyAccess(ctxFor(["ag/claude-opus-5-5"]), "claude-opus-5-5")).toBeNull();
    });

    it("denies a bare id for a key that lists only the anthropic model", async () => {
      await setup();
      const { enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
      const denied = await enforceKeyAccess(ctxFor(["anthropic/claude-opus-5-5"]), "claude-opus-5-5");
      expect(denied.status).toBe(403);
    });

    it("judges the pre-resolved model info instead of resolving again", async () => {
      await setup();
      const { enforceKeyAccess } = await import("@/sse/services/keyAccess.js");
      const allow = ["anthropic/claude-opus-5-5"];
      // Routing resolved the bare id to Antigravity; a fresh lookup (toggle flipped, DB error)
      // could say anthropic. The check must follow the routed target.
      const agInfo = { provider: "antigravity", model: "claude-opus-5-5" };
      expect((await enforceKeyAccess(ctxFor(allow), "claude-opus-5-5", agInfo)).status).toBe(403);
      const anthropicInfo = { provider: "anthropic", model: "claude-opus-5-5" };
      expect(await enforceKeyAccess(ctxFor(["ag/claude-opus-5-5"]), "claude-opus-5-5", agInfo)).toBeNull();
      expect((await enforceKeyAccess(ctxFor(["ag/claude-opus-5-5"]), "claude-opus-5-5", anthropicInfo)).status).toBe(403);
    });
  });

  describe("buildModelsList", () => {
    it("publishes bare Antigravity ids once, owned by antigravity", async () => {
      await setup();
      const { buildModelsList } = await import("@/app/api/v1/models/route.js");
      const models = await buildModelsList(["llm"]);
      const bare = models.filter((m) => m.id === "claude-opus-5-5");
      expect(bare).toHaveLength(1);
      expect(bare[0].owned_by).toBe("antigravity");
      expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    });

    it("skips bare ids that are user model aliases", async () => {
      const ctx = await setup();
      await ctx.db.setModelAlias("claude-opus-5-5", "cc/claude-opus-5-5");
      const { buildModelsList } = await import("@/app/api/v1/models/route.js");
      const models = await buildModelsList(["llm"]);
      expect(models.some((m) => m.id === "claude-opus-5-5" && m.owned_by === "antigravity")).toBe(false);
      expect(models.some((m) => m.id === "gemini-3.8-flash" && m.owned_by === "antigravity")).toBe(true);
    });

    it("publishes no bare Antigravity ids when the toggle is off", async () => {
      await setup({ enabled: false });
      const { buildModelsList } = await import("@/app/api/v1/models/route.js");
      const models = await buildModelsList(["llm"]);
      expect(models.some((m) => m.id === "claude-opus-5-5")).toBe(false);
    });
  });
});
