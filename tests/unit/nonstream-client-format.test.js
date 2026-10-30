import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { translateNonStreamingResponse, handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

// Fixtures follow the documented Gemini groundingMetadata shape (no live capture).
const GROUNDING = {
  webSearchQueries: ["hacker news top story"],
  groundingChunks: [
    { web: { uri: "https://example.com/a", title: "A" } },
    { web: { uri: "https://example.com/b", title: "B" } },
  ],
  groundingSupports: [{ segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0, 1] }],
};

const USAGE = { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 };

const geminiResponse = (parts, candidateExtra = {}) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP", ...candidateExtra }],
  usageMetadata: USAGE,
  modelVersion: "gemini-x",
  responseId: "r1",
  createTime: "2026-01-01T00:00:00Z",
});
const antigravityBody = (parts, extra) => ({ response: geminiResponse(parts, extra) });
const textParts = [{ text: "hello" }];

describe("non-stream replies are rendered in the client's format", () => {
  it("Antigravity -> Claude: plain text becomes an Anthropic message with usage", () => {
    const out = translateNonStreamingResponse(antigravityBody(textParts), FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
    expect(out.choices).toBeUndefined();
  });

  it.each([
    ["GEMINI", FORMATS.GEMINI, geminiResponse(textParts)],
    ["GEMINI_CLI", FORMATS.GEMINI_CLI, antigravityBody(textParts)],
    ["VERTEX", FORMATS.VERTEX, geminiResponse(textParts)],
  ])("%s upstream -> Claude client gets a message", (_n, target, body) => {
    const out = translateNonStreamingResponse(body, target, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(out.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("Antigravity -> Claude: grounding becomes search blocks and web_search_requests", () => {
    const out = translateNonStreamingResponse(
      antigravityBody(textParts, { groundingMetadata: GROUNDING }), FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    const use = out.content.find((b) => b.type === "server_tool_use");
    const result = out.content.find((b) => b.type === "web_search_tool_result");
    expect(use.name).toBe("web_search");
    expect(result.tool_use_id).toBe(use.id);
    expect(result.content.some((r) => r.type === "web_search_result")).toBe(true);
    expect(out.usage.server_tool_use.web_search_requests).toBeGreaterThanOrEqual(1);
    expect(out.content.some((b) => b.type === "tool_use" && b.name === "web_search")).toBe(false);
  });

  it("Antigravity -> Claude: functionCall becomes tool_use with stop_reason tool_use", () => {
    const out = translateNonStreamingResponse(
      antigravityBody([{ functionCall: { name: "get_weather", args: { city: "Hanoi" } } }]), FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    const tools = out.content.filter((b) => b.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_weather");
    expect(tools[0].input).toEqual({ city: "Hanoi" });
    expect(out.stop_reason).toBe("tool_use");
  });

  it("an already-OpenAI body behind a Gemini-family target is still rendered for Claude", () => {
    const openai = { id: "chatcmpl-x", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
    const out = translateNonStreamingResponse(openai, FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("OpenAI clients get the unchanged chat.completion for every upstream", () => {
    const claudeBody = { id: "msg_1", model: "claude-x", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } };
    const ollamaBody = { model: "llama", message: { role: "assistant", content: "yo" }, done: true, prompt_eval_count: 5, eval_count: 6, done_reason: "stop" };

    expect(translateNonStreamingResponse(antigravityBody(textParts), FORMATS.ANTIGRAVITY, FORMATS.OPENAI)).toEqual({
      id: "chatcmpl-r1", object: "chat.completion", created: 1767225600, model: "gemini-x",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    expect(translateNonStreamingResponse(claudeBody, FORMATS.CLAUDE, FORMATS.OPENAI)).toEqual({
      id: "chatcmpl-msg_1", object: "chat.completion", created: expect.any(Number), model: "claude-x",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    expect(translateNonStreamingResponse(ollamaBody, FORMATS.OLLAMA, FORMATS.OPENAI)).toEqual({
      id: expect.stringMatching(/^chatcmpl-/), object: "chat.completion", created: expect.any(Number), model: "llama",
      choices: [{ index: 0, message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    });
  });

  it("Antigravity -> Responses client gets an object:response body", () => {
    const out = translateNonStreamingResponse(antigravityBody(textParts), FORMATS.ANTIGRAVITY, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    const message = out.output.find((i) => i.type === "message");
    expect(message.content[0].text).toBe("hello");
  });

  it("handleNonStreamingResponse returns a Claude message with usage intact", async () => {
    const providerResponse = new Response(JSON.stringify(antigravityBody(textParts, { groundingMetadata: GROUNDING })), {
      headers: { "content-type": "application/json" },
    });
    const noop = () => {};
    const result = await handleNonStreamingResponse({
      providerResponse, provider: "antigravity", model: "gemini-x",
      sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.ANTIGRAVITY,
      body: {}, stream: false, requestStartTime: Date.now(),
      reqLogger: { logProviderResponse: noop, logConvertedResponse: noop },
      trackDone: noop, appendLog: noop,
    });
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.usage.input_tokens).toBeGreaterThan(0);
    expect(json.usage.server_tool_use.web_search_requests).toBeGreaterThanOrEqual(1);
    expect(json.object).toBeUndefined();
    expect(json.choices).toBeUndefined();
  });

  it("a body neither step recognises passes through unchanged", () => {
    expect(translateNonStreamingResponse({ foo: 1 }, FORMATS.ANTIGRAVITY, FORMATS.CLAUDE)).toEqual({ foo: 1 });
  });
});
