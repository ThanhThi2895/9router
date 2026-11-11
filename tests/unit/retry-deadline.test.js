// Phase 4: executor retries stop at the SSE commit deadline so a real 503 can still be sent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));

const chatCoreMock = vi.fn();
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: (...a) => chatCoreMock(...a) }));

const modelInfoByName = {};
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => modelInfoByName[m] || { provider: null },
  getComboModels: async () => null,
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_ctx, models) => models,
}));
const credsMock = vi.fn();
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: (...a) => credsMock(...a),
  markAccountUnavailable: async () => ({ shouldFallback: true }),
  clearAccountError: async () => {},
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: async () => {},
  checkAndRefreshToken: async (_p, c) => c,
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: async () => "proj" }));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

class StubExecutor extends BaseExecutor {
  constructor() {
    super("stub", { baseUrl: "http://upstream.test/x", retry: { 503: { attempts: 3, delayMs: 2000 } } });
  }
  buildHeaders() { return {}; }
  // Mirrors antigravity: 2s, 4s, 8s.
  async computeRetryDelay(_res, attempt) { return 1000 * 2 ** attempt; }
}

const resp = (status) => ({ status, ok: status < 400, headers: { get: () => null } });
const run = (executor, extra = {}) => executor.execute({ model: "m", body: {}, stream: true, credentials: {}, ...extra });

describe("BaseExecutor retryDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(200));
  });
  afterEach(() => vi.useRealTimers());

  it("runs the 2s retry, skips the 4s retry and returns the 503 inside the deadline", async () => {
    const start = Date.now();
    const p = run(new StubExecutor(), { retryDeadline: start + 3000 });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await p;
    expect(result.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("runs every retry when retryDeadline is null", async () => {
    const p = run(new StubExecutor(), { retryDeadline: null });
    await vi.advanceTimersByTimeAsync(14000);
    const result = await p;
    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("skips retries entirely when the deadline is already past", async () => {
    const result = await run(new StubExecutor(), { retryDeadline: Date.now() - 1 });
    expect(result.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleChat keepalive retry deadline", () => {
  const req = (model) => new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

  beforeEach(() => {
    chatCoreMock.mockReset();
    credsMock.mockReset();
    modelInfoByName["antigravity/gemini-x"] = { provider: "antigravity", model: "gemini-x" };
    modelInfoByName["openai/gpt-x"] = { provider: "openai", model: "gpt-x" };
    let n = 0;
    credsMock.mockImplementation(async () => {
      n++;
      if (n <= 2) return { connectionId: `c${n}`, connectionName: `acc${n}`, providerSpecificData: {} };
      return { allRateLimited: true, retryAfter: new Date(Date.now() + 5000).toISOString(), retryAfterHuman: "reset after 5s", lastError: "capacity" };
    });
    chatCoreMock.mockResolvedValue({
      success: false, status: 503, error: "No capacity available",
      response: new Response("x", { status: 503 }),
    });
  });

  it("returns a real 503 with retry-after for antigravity capacity errors on two accounts", async () => {
    const res = await handleChat(req("antigravity/gemini-x"), null, { keepalive: true });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(chatCoreMock).toHaveBeenCalledTimes(2);
    for (const [arg] of chatCoreMock.mock.calls) {
      expect(typeof arg.retryDeadline).toBe("number");
      expect(arg.retryDeadline).toBeGreaterThan(Date.now());
    }
  });

  it("passes retryDeadline null to chatCore for non-antigravity providers", async () => {
    await handleChat(req("openai/gpt-x"), null, { keepalive: true });
    expect(chatCoreMock).toHaveBeenCalled();
    for (const [arg] of chatCoreMock.mock.calls) expect(arg.retryDeadline).toBeNull();
  });

  it("passes no deadline when keepalive is off", async () => {
    await handleChat(req("antigravity/gemini-x"));
    for (const [arg] of chatCoreMock.mock.calls) expect(arg.retryDeadline).toBeNull();
  });
});
