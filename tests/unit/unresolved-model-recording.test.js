import { describe, it, expect, vi, beforeEach } from "vitest";
import { isModelNotFoundError, recordUnresolvedModel, createUpstreamModelNotFoundRecorder } from "../../src/sse/services/unresolvedModel.js";
import * as repo from "../../src/lib/db/repos/unresolvedModelsRepo.js";

describe("isModelNotFoundError", () => {
  it("returns true for status 404 regardless of error message", () => {
    expect(isModelNotFoundError(404, "Not Found")).toBe(true);
    expect(isModelNotFoundError(404, "")).toBe(true);
    expect(isModelNotFoundError(404, null)).toBe(true);
  });

  it("returns true for 400 / 422 matching model-not-found patterns", () => {
    expect(isModelNotFoundError(400, "The model `gpt-5` does not exist")).toBe(true);
    expect(isModelNotFoundError(400, "model not found")).toBe(true);
    expect(isModelNotFoundError(400, "Model 'xyz' is unknown")).toBe(true);
    expect(isModelNotFoundError(422, "model not supported")).toBe(true);
    expect(isModelNotFoundError(400, "No such model exists")).toBe(true);
    expect(
      isModelNotFoundError(400, { message: "The model `foo` does not exist" })
    ).toBe(true);
  });

  it("returns false for non-matching 400 errors", () => {
    expect(isModelNotFoundError(400, "Invalid JSON body")).toBe(false);
    expect(
      isModelNotFoundError(400, "Maximum context length exceeded: 1048576 tokens")
    ).toBe(false);
    expect(isModelNotFoundError(400, "Missing required parameter: prompt")).toBe(false);
  });

  it("returns false for 400s that merely mention the model", () => {
    expect(isModelNotFoundError(400, "This model's maximum context length is 8192 tokens. Invalid request.")).toBe(false);
    expect(isModelNotFoundError(400, "[400]: model gpt-4o: Invalid type for messages[2].content")).toBe(false);
    expect(isModelNotFoundError(400, '{"model":"claude-x","error":{"type":"invalid_request_error"}}')).toBe(false);
  });

  it("returns true for explicit model_not_found codes and phrases", () => {
    expect(isModelNotFoundError(400, '{"error":{"code":"model_not_found"}}')).toBe(true);
    expect(isModelNotFoundError(400, "Invalid model: foo")).toBe(true);
    expect(isModelNotFoundError(400, "unsupported model foo")).toBe(true);
  });

  it("returns false for other status codes (429, 500, 503)", () => {
    expect(isModelNotFoundError(429, "Rate limit reached")).toBe(false);
    expect(isModelNotFoundError(500, "Internal Server Error")).toBe(false);
    expect(isModelNotFoundError(503, "Service Unavailable")).toBe(false);
  });
});

describe("recordUnresolvedModel fail-open behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("never throws even when underlying repo fails", () => {
    vi.spyOn(repo, "recordUnresolvedModelEvent").mockImplementation(() => {
      throw new Error("DB write failure simulated");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      recordUnresolvedModel({
        endpoint: "/v1/chat/completions",
        requestedModel: "broken-model",
        reason: "missing_model",
      });
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("correctly forwards sanitized fields to recordUnresolvedModelEvent", () => {
    const spy = vi.spyOn(repo, "recordUnresolvedModelEvent").mockImplementation(() => {});

    const fakeReq = {
      url: "http://localhost:20128/v1/chat/completions",
      headers: new Headers({ "user-agent": "test-agent/1.0" }),
    };

    recordUnresolvedModel({
      request: fakeReq,
      requestedModel: "gpt-fake",
      reason: "no_credentials",
      provider: "openai",
      error: "No active connection",
    });

    expect(spy).toHaveBeenCalledWith({
      endpoint: "/v1/chat/completions",
      requestedModel: "gpt-fake",
      reason: "no_credentials",
      provider: "openai",
      error: "No active connection",
      userAgent: "test-agent/1.0",
    });
  });
});


describe("createUpstreamModelNotFoundRecorder", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("records once per request no matter how many accounts failed", () => {
    const spy = vi.spyOn(repo, "recordUnresolvedModelEvent").mockImplementation(() => {});
    const rec = createUpstreamModelNotFoundRecorder({ endpoint: "/v1/x", requestedModel: "m", provider: "p" });
    rec.observe(404, "nf");
    rec.observe(404, "nf");
    rec.observe(404, "nf");
    rec.commit();
    rec.commit();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ reason: "upstream_model_not_found", requestedModel: "m", provider: "p" });
  });

  it("records nothing when the final attempt failed for another reason", () => {
    const spy = vi.spyOn(repo, "recordUnresolvedModelEvent").mockImplementation(() => {});
    const rec = createUpstreamModelNotFoundRecorder({ endpoint: "/v1/x", requestedModel: "m", provider: "p" });
    rec.observe(404, "nf");
    rec.observe(429, "rate limited");
    rec.commit();
    expect(spy).not.toHaveBeenCalled();
  });
});
