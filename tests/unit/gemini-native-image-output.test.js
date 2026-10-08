import { beforeEach, describe, expect, it, vi } from "vitest";

// Image models (e.g. antigravity/gemini-3.1-flash-image) are always answered
// non-streaming upstream; the Gemini-native endpoint must still hand the client
// an inlineData part on both :generateContent and :streamGenerateContent, or
// Gemini clients report "no image data returned by the model".

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(),
  isValidApiKey: vi.fn().mockResolvedValue(true),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/geminiModel.js", () => ({
  resolveGeminiModel: vi.fn(async () => "antigravity/gemini-3.1-flash-image"),
}));

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const { translateNonStreamingResponse } = await import("open-sse/handlers/chatCore/nonStreamingHandler.js");
const { openaiToAntigravityResponse } = await import("open-sse/translator/response/openai-to-antigravity.js");
const { FORMATS } = await import("open-sse/translator/formats.js");

const IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Upstream Antigravity generateContent body for an image model.
const upstreamImageBody = {
  response: {
    candidates: [{
      content: { role: "model", parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/png", data: IMAGE_B64 } }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
    modelVersion: "gemini-3.1-flash-image",
    responseId: "resp_1",
  },
};

function chatCompletionFromUpstream() {
  return translateNonStreamingResponse(structuredClone(upstreamImageBody), FORMATS.ANTIGRAVITY, FORMATS.OPENAI);
}

function makeRequest(action) {
  return new Request(`https://router.test/v1beta/models/gemini-3.1-flash-image${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "draw a cat" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
}

function inlineParts(parts) {
  return (parts || []).filter((p) => p.inlineData?.data);
}

describe("Gemini-native image output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.handleChat.mockImplementation(async () =>
      Response.json(chatCompletionFromUpstream(), { headers: { "Content-Type": "application/json" } })
    );
  });

  it("non-stream Gemini→OpenAI translation exposes images as message.images", () => {
    const message = chatCompletionFromUpstream().choices[0].message;
    expect(message.images).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE_B64}` } },
    ]);
  });

  it("openai→antigravity response translation emits delta.images as inlineData", () => {
    const out = openaiToAntigravityResponse({
      id: "x",
      choices: [{ delta: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE_B64}` } }] }, finish_reason: null }],
    }, {});
    expect(inlineParts(out.response.candidates[0].content.parts)).toEqual([
      { inlineData: { mimeType: "image/png", data: IMAGE_B64 } },
    ]);
  });

  it(":generateContent returns the image as an inlineData part", async () => {
    const res = await POST(makeRequest(":generateContent"), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-image:generateContent"] }),
    });
    const json = await res.json();
    const parts = json.candidates[0].content.parts;

    expect(inlineParts(parts)).toEqual([{ inlineData: { mimeType: "image/png", data: IMAGE_B64 } }]);
    // The base64 must not also be smuggled through the text part.
    expect(parts.filter((p) => p.text).map((p) => p.text).join("")).not.toContain(IMAGE_B64);
  });

  it(":streamGenerateContent returns the image when the upstream answered non-streaming", async () => {
    const res = await POST(makeRequest(":streamGenerateContent"), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-image:streamGenerateContent"] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)));
    const parts = events.flatMap((e) => e.candidates?.[0]?.content?.parts || []);

    expect(inlineParts(parts)).toEqual([{ inlineData: { mimeType: "image/png", data: IMAGE_B64 } }]);
    expect(events.at(-1).candidates[0].finishReason).toBe("STOP");
  });
});
