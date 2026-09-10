import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gemini clients carry the reasoning effort in the request body, never in the
 * model name — `agy --effort low` and `--effort high` both send
 * "gemini-3.8-flash". Providers publish effort as separate model ids, so the
 * endpoint has to move it across, and only onto a variant that exists: asking
 * for a name the provider never published returns 404, and repeated 404s get
 * upstream accounts locked out.
 */

const mocks = vi.hoisted(() => ({ getModelAliases: vi.fn() }));

vi.mock("@/lib/localDb", () => ({ getModelAliases: mocks.getModelAliases }));

const { resolveGeminiModel, effortFromThinkingBudget } = await import(
  "../../src/sse/services/geminiModel.js"
);

/** A request body carrying the thinking budget a Gemini client would send. */
function withBudget(thinkingBudget) {
  return { generationConfig: { thinkingConfig: { thinkingBudget } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getModelAliases.mockResolvedValue({});
});

describe("effortFromThinkingBudget", () => {
  it("maps the three budgets Gemini CLI sends", () => {
    expect(effortFromThinkingBudget(1000)).toBe("low");
    expect(effortFromThinkingBudget(4000)).toBe("medium");
    expect(effortFromThinkingBudget(-1)).toBe("high");
  });

  it("treats an absent or unusable budget as unstated", () => {
    expect(effortFromThinkingBudget(undefined)).toBeNull();
    expect(effortFromThinkingBudget("1000")).toBeNull();
    expect(effortFromThinkingBudget(NaN)).toBeNull();
  });
});

describe("resolveGeminiModel", () => {
  it("picks the variant matching the requested effort", async () => {
    expect(await resolveGeminiModel("ag/gemini-3.8-flash", withBudget(-1)))
      .toBe("ag/gemini-3.8-flash-high");
    expect(await resolveGeminiModel("ag/gemini-3.8-flash", withBudget(4000)))
      .toBe("ag/gemini-3.8-flash-medium");
    expect(await resolveGeminiModel("ag/gemini-3.8-flash", withBudget(1000)))
      .toBe("ag/gemini-3.8-flash-low");
  });

  it("prefers the bare name when the client stated no effort", async () => {
    expect(await resolveGeminiModel("ag/gemini-3.8-flash", {}))
      .toBe("ag/gemini-3.8-flash");
  });

  it("falls back to the nearest effort the provider actually publishes", async () => {
    // gemini-3.1-pro exists only as -low, so a request for high lands there
    // instead of asking for a -high that would 404.
    expect(await resolveGeminiModel("ag/gemini-3.1-pro", withBudget(-1)))
      .toBe("ag/gemini-3.1-pro-low");
  });

  it("leaves an id that already pins an effort alone", async () => {
    expect(await resolveGeminiModel("ag/gemini-3.8-flash-high", withBudget(1000)))
      .toBe("ag/gemini-3.8-flash-high");
  });

  it("resolves the alias table before looking at effort", async () => {
    mocks.getModelAliases.mockResolvedValue({ "gemini-3.8-flash": "ag/gemini-3.8-flash" });

    // Alias resolution canonicalises the provider alias "ag" to its id, which is
    // the form the chat pipeline routes on.
    expect(await resolveGeminiModel("gemini-3.8-flash", withBudget(-1)))
      .toBe("antigravity/gemini-3.8-flash-high");
  });

  it("returns names it cannot place untouched", async () => {
    // No provider prefix and no alias — nothing to look up a catalog in.
    expect(await resolveGeminiModel("gemini-3.8-flash", withBudget(-1)))
      .toBe("gemini-3.8-flash");
    // Unknown provider.
    expect(await resolveGeminiModel("nope/some-model", withBudget(-1)))
      .toBe("nope/some-model");
    // Known provider, model it never published.
    expect(await resolveGeminiModel("ag/not-a-real-model", withBudget(-1)))
      .toBe("ag/not-a-real-model");
  });

  it("survives an unreachable alias store", async () => {
    mocks.getModelAliases.mockRejectedValue(new Error("db down"));

    expect(await resolveGeminiModel("ag/gemini-3.8-flash", withBudget(-1)))
      .toBe("ag/gemini-3.8-flash-high");
  });
});
