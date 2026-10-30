import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fixtures follow the documented Gemini groundingMetadata shape (no live capture).
 * Grounding must survive Gemini -> OpenAI -> client: `annotations` (url_citation)
 * for OpenAI clients and the raw `grounding_metadata` for /v1beta clients.
 */

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getModelAliases: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getModelAliases: mocks.getModelAliases,
}));

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const { geminiToOpenAIResponse } = await import("../../open-sse/translator/response/gemini-to-openai.js");
const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { groundingToAnnotations } = await import("../../open-sse/translator/concerns/grounding.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const GROUNDING = {
  webSearchQueries: ["hacker news top story"],
  groundingChunks: [
    { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "Hacker News" } },
    { web: { uri: "https://example.com/post", title: "Example Post" } },
  ],
  groundingSupports: [
    { segment: { startIndex: 0, endIndex: 12, text: "Top story is" }, groundingChunkIndices: [0, 1] },
  ],
  searchEntryPoint: { renderedContent: "<div>Google</div>" },
};

const EXPECTED_ANNOTATIONS = [
  { type: "url_citation", url_citation: { url: GROUNDING.groundingChunks[0].web.uri, title: "Hacker News", start_index: 0, end_index: 12 } },
  { type: "url_citation", url_citation: { url: GROUNDING.groundingChunks[1].web.uri, title: "Example Post", start_index: 0, end_index: 12 } },
];

const textChunk = (text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }], responseId: "r1", modelVersion: "gemini-x" });
const finishChunk = (extra = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", ...extra }], responseId: "r1", modelVersion: "gemini-x" });
const groundedFinish = () => finishChunk({ groundingMetadata: GROUNDING });

function runStream(chunks) {
  const state = {};
  return chunks.flatMap((c) => geminiToOpenAIResponse(c, state) || []);
}

const deltas = (out) => out.map((c) => c.choices[0].delta);

function sseOf(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

describe("groundingToAnnotations", () => {
  it("cites each supported chunk with its span", () => {
    expect(groundingToAnnotations(GROUNDING)).toEqual(EXPECTED_ANNOTATIONS);
  });

  it("cites each source once with no span when there are no supports", () => {
    const out = groundingToAnnotations({ groundingChunks: GROUNDING.groundingChunks });
    expect(out).toEqual([
      { type: "url_citation", url_citation: { url: GROUNDING.groundingChunks[0].web.uri, title: "Hacker News" } },
      { type: "url_citation", url_citation: { url: GROUNDING.groundingChunks[1].web.uri, title: "Example Post" } },
    ]);
  });

  it("ignores out-of-range indexes and chunks without a uri", () => {
    expect(groundingToAnnotations({
      groundingChunks: [{ retrievedContext: {} }],
      groundingSupports: [{ groundingChunkIndices: [0, 5, "x"] }],
    })).toEqual([]);
  });
});

describe("gemini -> openai stream", () => {
  it("attaches annotations and grounding_metadata once, on the finish chunk", () => {
    const out = runStream([textChunk("Top story is X"), groundedFinish()]);
    const withGrounding = out.filter((c) => c.choices[0].delta.grounding_metadata);
    expect(withGrounding).toHaveLength(1);
    const last = out[out.length - 1];
    expect(last).toBe(withGrounding[0]);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.choices[0].delta.annotations).toEqual(EXPECTED_ANNOTATIONS);
    expect(last.choices[0].delta.grounding_metadata).toEqual(GROUNDING);
  });

  it("keeps grounding that arrives before the finish chunk and attaches it to the finish", () => {
    const out = runStream([{ candidates: [{ content: { parts: [{ text: "hi" }] }, groundingMetadata: GROUNDING }] }, finishChunk()]);
    expect(out.filter((c) => c.choices[0].delta.grounding_metadata)).toHaveLength(1);
    expect(out[out.length - 1].choices[0].finish_reason).toBe("stop");
    expect(out[out.length - 1].choices[0].delta.grounding_metadata).toEqual(GROUNDING);
  });

  it("emits a late grounding arrival as one lone chunk without a finish reason", () => {
    const out = runStream([textChunk("hi"), finishChunk(), { candidates: [{ groundingMetadata: GROUNDING }] }]);
    const grounded = out.filter((c) => c.choices[0].delta.grounding_metadata);
    expect(grounded).toHaveLength(1);
    expect(grounded[0].choices[0].finish_reason).toBeNull();
    expect(Object.keys(grounded[0].choices[0].delta).sort()).toEqual(["annotations", "grounding_metadata"]);
    expect(out.find((c) => c.choices[0].finish_reason).choices[0].delta.grounding_metadata).toBeUndefined();
  });

  it("holds the finish of a search request until trailing grounding arrives", () => {
    const state = { webSearchRequested: true };
    const run = (c) => geminiToOpenAIResponse(c, state) || [];
    const before = [...run(textChunk("hi")), ...run(finishChunk())];
    expect(before.some((c) => c.choices[0].finish_reason)).toBe(false);
    const after = run({ candidates: [{ groundingMetadata: GROUNDING }] });
    expect(after).toHaveLength(1);
    expect(after[0].choices[0].finish_reason).toBe("stop");
    expect(after[0].choices[0].delta.annotations).toEqual(EXPECTED_ANNOTATIONS);
    expect(after[0].choices[0].delta.grounding_metadata).toEqual(GROUNDING);
    expect(geminiToOpenAIResponse(null, state)).toBeNull();
  });

  it("releases a held finish without grounding at end of stream", () => {
    const state = { webSearchRequested: true };
    geminiToOpenAIResponse(textChunk("hi"), state);
    expect(geminiToOpenAIResponse(finishChunk(), state)).toBeNull();
    const [tail] = geminiToOpenAIResponse(null, state);
    expect(tail.choices[0].finish_reason).toBe("stop");
    expect(tail.choices[0].delta).toEqual({});
  });

  it("does not hold the finish when the request asked for no search", () => {
    const out = runStream([textChunk("hi"), finishChunk()]);
    expect(out.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("adds no grounding fields when upstream sent none", () => {
    const out = runStream([textChunk("hi"), finishChunk()]);
    for (const d of deltas(out)) {
      expect(d).not.toHaveProperty("annotations");
      expect(d).not.toHaveProperty("grounding_metadata");
    }
  });
});

describe("non-streaming aggregation", () => {
  it("parseSSEToOpenAIResponse keeps annotations and grounding_metadata on the message", () => {
    const parsed = parseSSEToOpenAIResponse(sseOf(runStream([textChunk("Top story is X"), groundedFinish()])), "m");
    const message = parsed.choices[0].message;
    expect(message.content).toBe("Top story is X");
    expect(message.annotations).toEqual(EXPECTED_ANNOTATIONS);
    expect(message.grounding_metadata).toEqual(GROUNDING);
  });

  it("parseSSEToOpenAIResponse merges a late lone grounding chunk", () => {
    const parsed = parseSSEToOpenAIResponse(
      sseOf(runStream([textChunk("hi"), finishChunk(), { candidates: [{ groundingMetadata: GROUNDING }] }])),
      "m"
    );
    expect(parsed.choices[0].message.annotations).toEqual(EXPECTED_ANNOTATIONS);
    expect(parsed.choices[0].message.grounding_metadata).toEqual(GROUNDING);
    expect(parsed.choices[0].finish_reason).toBe("stop");
  });

  it("parseSSEToOpenAIResponse keeps the latest annotations instead of summing them", () => {
    const finish = runStream([textChunk("Top story is X"), groundedFinish()]);
    const lateRepeat = { id: "chatcmpl-r1", choices: [{ index: 0, delta: { annotations: EXPECTED_ANNOTATIONS, grounding_metadata: GROUNDING }, finish_reason: null }] };
    const parsed = parseSSEToOpenAIResponse(sseOf([...finish, lateRepeat]), "m");
    expect(parsed.choices[0].message.annotations).toEqual(EXPECTED_ANNOTATIONS);
    expect(parsed.choices[0].message.grounding_metadata).toEqual(GROUNDING);
  });

  it("translateNonStreamingResponse (antigravity -> openai) matches the stream aggregate", () => {
    const body = {
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "Top story is X" }] }, finishReason: "STOP", groundingMetadata: GROUNDING }],
        responseId: "r1",
        modelVersion: "gemini-x",
      },
    };
    const message = translateNonStreamingResponse(body, FORMATS.ANTIGRAVITY, FORMATS.OPENAI).choices[0].message;
    expect(message.content).toBe("Top story is X");
    expect(message.annotations).toEqual(EXPECTED_ANNOTATIONS);
    expect(message.grounding_metadata).toEqual(GROUNDING);
  });

  it("leaves ungrounded messages without grounding keys", () => {
    const body = { response: { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] } };
    const message = translateNonStreamingResponse(body, FORMATS.ANTIGRAVITY, FORMATS.OPENAI).choices[0].message;
    expect(message).not.toHaveProperty("annotations");
    expect(message).not.toHaveProperty("grounding_metadata");
  });
});

describe("/v1beta round-trip", () => {
  const params = (action) => ({ params: Promise.resolve({ path: ["ag", `gemini-3.8-flash:${action}`] }) });
  const request = (action) => new Request(`https://router.test/v1beta/models/ag/gemini-3.8-flash:${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hn?" }] }] }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelAliases.mockResolvedValue({});
  });

  it("streams candidates[0].groundingMetadata unchanged on the last event", async () => {
    const chunks = runStream([textChunk("Top story is X"), groundedFinish()]);
    mocks.handleChat.mockResolvedValue(new Response(sseOf(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const res = await POST(request("streamGenerateContent"), params("streamGenerateContent"));
    const events = (await res.text()).split("\n").filter((l) => l.trim().startsWith("data:")).map((l) => JSON.parse(l.trim().slice(5)));
    const grounded = events.filter((e) => e.candidates[0].groundingMetadata);
    expect(grounded).toHaveLength(1);
    expect(events[events.length - 1]).toBe(events.find((e) => e.candidates[0].groundingMetadata));
    expect(grounded[0].candidates[0].groundingMetadata).toEqual(GROUNDING);
  });

  it("returns candidates[0].groundingMetadata unchanged from :generateContent", async () => {
    const parsed = parseSSEToOpenAIResponse(sseOf(runStream([textChunk("Top story is X"), groundedFinish()])), "m");
    mocks.handleChat.mockResolvedValue(Response.json(parsed));

    const res = await POST(request("generateContent"), params("generateContent"));
    const json = await res.json();
    expect(json.candidates[0].content.parts[0].text).toBe("Top story is X");
    expect(json.candidates[0].groundingMetadata).toEqual(GROUNDING);
  });

  it("omits groundingMetadata for an ungrounded reply", async () => {
    mocks.handleChat.mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const res = await POST(request("generateContent"), params("generateContent"));
    expect((await res.json()).candidates[0]).not.toHaveProperty("groundingMetadata");
  });
});
