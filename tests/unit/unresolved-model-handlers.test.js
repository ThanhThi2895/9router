import { describe, it, expect, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const coreMocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
  getModelInfo: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: coreMocks.getModelInfo }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: coreMocks.handleEmbeddingsCore }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), request: vi.fn(), maskKey: (k) => k,
}));

import * as repo from "@/lib/db/repos/unresolvedModelsRepo.js";
import { handleEmbeddings } from "@/sse/handlers/embeddings.js";

const makeRequest = (body) =>
  new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "t/1" },
    body: JSON.stringify(body),
  });

const failure = (status, error) => ({ success: false, status, error, response: new Response(error, { status }) });

describe("handleEmbeddings missing-model recording", () => {
  let spy;
  beforeEach(() => {
    vi.clearAllMocks();
    spy = vi.spyOn(repo, "recordUnresolvedModelEvent").mockImplementation(() => {});
    coreMocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-x" });
  });

  it("records missing_model and keeps the 400", async () => {
    const res = await handleEmbeddings(makeRequest({ input: "hi" }));
    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ reason: "missing_model", endpoint: "/v1/embeddings" }));
  });

  it("records invalid_model_format and keeps the 400", async () => {
    coreMocks.getModelInfo.mockResolvedValue({ provider: null, model: null });
    const res = await handleEmbeddings(makeRequest({ model: "nope", input: "hi" }));
    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid_model_format", requestedModel: "nope" }));
  });

  it("records no_credentials with the provider", async () => {
    authMocks.getProviderCredentials.mockResolvedValue(null);
    const res = await handleEmbeddings(makeRequest({ model: "openai/text-embedding-x", input: "hi" }));
    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ reason: "no_credentials", provider: "openai" }));
  });

  it("records upstream_model_not_found once across several failing accounts", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "a" })
      .mockResolvedValueOnce({ connectionId: "b" })
      .mockResolvedValueOnce({ connectionId: "c" })
      .mockResolvedValueOnce(null);
    coreMocks.handleEmbeddingsCore.mockResolvedValue(failure(404, "model_not_found"));
    const res = await handleEmbeddings(makeRequest({ model: "openai/text-embedding-x", input: "hi" }));
    expect(res.status).toBe(404);
    const upstream = spy.mock.calls.filter(([e]) => e.reason === "upstream_model_not_found");
    expect(upstream).toHaveLength(1);
    expect(upstream[0][0]).toMatchObject({ provider: "openai", requestedModel: "openai/text-embedding-x" });
  });

  it("does not record when a later account succeeds", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "a" })
      .mockResolvedValueOnce({ connectionId: "b" });
    coreMocks.handleEmbeddingsCore
      .mockResolvedValueOnce(failure(404, "model_not_found"))
      .mockResolvedValueOnce({ success: true, response: new Response("{}", { status: 200 }), usage: null });
    const res = await handleEmbeddings(makeRequest({ model: "openai/text-embedding-x", input: "hi" }));
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not record a non model-not-found 400", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "a" });
    authMocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    coreMocks.handleEmbeddingsCore.mockResolvedValue(failure(400, "This model's maximum context length is 8192 tokens. Invalid request."));
    const res = await handleEmbeddings(makeRequest({ model: "openai/text-embedding-x", input: "hi" }));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("stays fail-open when the repo throws", async () => {
    spy.mockImplementation(() => { throw new Error("db down"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "a" }).mockResolvedValueOnce(null);
    coreMocks.handleEmbeddingsCore.mockResolvedValue(failure(404, "model_not_found"));
    const res = await handleEmbeddings(makeRequest({ model: "openai/text-embedding-x", input: "hi" }));
    expect(res.status).toBe(404);
  });
});
