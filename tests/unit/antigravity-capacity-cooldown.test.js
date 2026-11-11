import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const CAPACITY_BODY = '{"error":{"status":"UNAVAILABLE","message":"No capacity available for model gemini-x","details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}';

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "ag-a",
    provider: "antigravity",
    name: "ag-a",
    backoffLevel: 7,
  }]);
});

describe("Antigravity capacity error cooldown", () => {
  it("uses a fixed 5s cooldown and no backoff level for the reason code", () => {
    const result = checkFallbackError(503, CAPACITY_BODY, 7, "antigravity");
    expect(result).toEqual({ shouldFallback: true, cooldownMs: 5000 });
    expect(result).not.toHaveProperty("newBackoffLevel");
  });

  it("matches the human message alone", () => {
    const result = checkFallbackError(503, "No capacity available for model gemini-x", 7, "antigravity");
    expect(result).toEqual({ shouldFallback: true, cooldownMs: 5000 });
  });

  it.each(["codex", null])("keeps the generic capacity backoff for provider %s", (provider) => {
    const result = checkFallbackError(503, CAPACITY_BODY, 7, provider);
    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(8);
  });

  it("markAccountUnavailable keeps the backoff level and locks the model for ~5s", async () => {
    const before = Date.now();
    await markAccountUnavailable("ag-a", 503, "No capacity available for model gemini-x", "antigravity", "gemini-x");

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update.backoffLevel).toBe(7);
    const lockMs = new Date(update["modelLock_gemini-x"]).getTime() - before;
    expect(lockMs).toBeGreaterThan(4000);
    expect(lockMs).toBeLessThanOrEqual(6000);
  });
});
