import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
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

const { getProviderCredentials, markAccountUnavailable, clearAccountError } =
  await import("../../src/sse/services/auth.js");

const NOW = new Date("2026-11-11T00:00:00.000Z");
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("all-locked error is scoped to the requested model", () => {
  it("uses the requested model's lock time and error, not another model's", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "a", provider: "p",
        modelLock_m1: at(600_000), modelLock_m2: at(30_000),
        modelLockError_m1: { message: "m1 capacity", status: 503 },
        modelLockError_m2: { message: "m2 forbidden", status: 403 },
        lastError: "m2 forbidden", errorCode: 403,
      },
      {
        id: "b", provider: "p",
        modelLock_m1: at(720_000),
        modelLockError_m1: { message: "b m1 error", status: 429 },
      },
    ]);
    const res = await getProviderCredentials("p", null, "m1");
    expect(res.allRateLimited).toBe(true);
    expect(res.retryAfter).toBe(at(600_000));
    expect(res.lastError).toBe("m1 capacity");
    expect(res.lastErrorCode).toBe(503);
  });

  it("modelLock___all later than the model lock wins for that connection", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "a", provider: "p",
        modelLock_m1: at(60_000), modelLock___all: at(900_000),
        modelLockError_m1: { message: "m1 err", status: 503 },
        modelLockError___all: { message: "monthly", status: 402 },
      },
    ]);
    const res = await getProviderCredentials("p", null, "m1");
    expect(res.retryAfter).toBe(at(900_000));
    expect(res.lastError).toBe("monthly");
    expect(res.lastErrorCode).toBe(402);
  });

  it("falls back to the __all error when only the account-level lock exists", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "a", provider: "p", modelLock___all: at(900_000), modelLockError___all: { message: "monthly", status: 402 } },
    ]);
    const res = await getProviderCredentials("p", null, "m1");
    expect(res.lastError).toBe("monthly");
    expect(res.lastErrorCode).toBe(402);
  });

  it("missing modelLockError yields a generic message, not lastError", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "a", provider: "p", modelLock_m1: at(60_000), lastError: "other model's error", errorCode: 403 },
    ]);
    const res = await getProviderCredentials("p", null, "m1");
    expect(res.lastError).not.toContain("other model's error");
    expect(res.lastError).toContain("m1");
    expect(res.lastErrorCode).toBeNull();
  });
});

describe("per-model lock error storage", () => {
  it("markAccountUnavailable writes modelLock_<m> and modelLockError_<m>", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "a", provider: "p", backoffLevel: 0 }]);
    await markAccountUnavailable("a", 503, "No capacity available", "p", "m1");
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock_m1");
    expect(update.modelLockError_m1).toEqual({ message: "No capacity available", status: 503 });
    expect(update.errorCode).toBe(503);
  });

  it("clearAccountError nulls the model's error key", async () => {
    const conn = {
      id: "a", testStatus: "unavailable", lastError: "x",
      modelLock_m1: at(60_000), modelLockError_m1: { message: "x", status: 503 },
      modelLock_m2: at(60_000), modelLockError_m2: { message: "y", status: 503 },
    };
    await clearAccountError("a", conn, "m1");
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update.modelLock_m1).toBeNull();
    expect(update.modelLockError_m1).toBeNull();
    expect(update).not.toHaveProperty("modelLockError_m2");
  });

  it("full reset nulls every error key", async () => {
    const conn = {
      id: "a", testStatus: "unavailable", lastError: "x",
      modelLock_m1: at(60_000), modelLockError_m1: { message: "x", status: 503 },
      modelLockError_m2: { message: "stale", status: 503 }, // lock already cleaned earlier
    };
    await clearAccountError("a", conn, "m1");
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update.modelLockError_m2).toBeNull();
    expect(update.testStatus).toBe("active");
  });
});
