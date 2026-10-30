import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import { openAICompletionToClaudeMessage } from "../../open-sse/translator/concerns/claudeMessage.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// Fixtures follow the documented Gemini groundingMetadata shape (no live capture).
const GROUNDING = {
  webSearchQueries: ["hacker news top story", "second query"],
  groundingChunks: [
    { web: { uri: "https://example.com/a", title: "A" } },
    { web: { uri: "https://example.com/b", title: "B" } },
    { web: { uri: "https://example.com/a", title: "A again" } },
  ],
  groundingSupports: [{ segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0, 1] }],
};

const chunk = (delta, finish_reason = null, extra = {}) => ({
  id: "chatcmpl-abcdefgh1234", model: "gemini-x", choices: [{ index: 0, delta, finish_reason }], ...extra,
});

const run = (chunks) => {
  const state = initState(FORMATS.CLAUDE);
  return chunks.flatMap((c) => openaiToClaudeResponse(c, state) || []);
};

const shape = (events) => events.map((e) => (e.content_block ? `${e.type}:${e.content_block.type}` : e.delta?.type ? `${e.type}:${e.delta.type}` : e.type));

describe("Gemini grounding -> Anthropic web_search blocks", () => {
  it("streams text, then server_tool_use, then web_search_tool_result, then message_delta", () => {
    const out = run([
      chunk({ role: "assistant", content: "Top story" }),
      chunk({ content: "" , grounding_metadata: GROUNDING}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 3 } }),
    ]);
    expect(shape(out)).toEqual([
      "message_start",
      "content_block_start:text", "content_block_delta:text_delta", "content_block_stop",
      "content_block_start:server_tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:web_search_tool_result", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    const starts = out.filter((e) => e.type === "content_block_start");
    expect(starts.map((e) => e.index)).toEqual([0, 1, 2]);
    const use = starts[1].content_block;
    expect(use.id).toMatch(/^srvtoolu_[0-9A-Za-z]{24}$/);
    expect(use.input).toEqual({});
    expect(JSON.parse(out.find((e) => e.delta?.type === "input_json_delta").delta.partial_json)).toEqual({ query: "hacker news top story" });
    const result = starts[2].content_block;
    expect(result.tool_use_id).toBe(use.id);
    expect(result.content.map((r) => r.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.content[0]).toEqual({ type: "web_search_result", url: "https://example.com/a", title: "A", encrypted_content: "", page_age: null });
    const md = out.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage.server_tool_use.web_search_requests).toBe(2);
  });

  it("closes open thinking and text blocks before the search blocks", () => {
    const out = run([
      chunk({ role: "assistant", reasoning_content: "hmm" }),
      chunk({ content: "answer" }),
      chunk({ grounding_metadata: GROUNDING }),
      chunk({}, "stop"),
    ]);
    expect(shape(out)).toEqual([
      "message_start",
      "content_block_start:thinking", "content_block_delta:thinking_delta", "content_block_stop",
      "content_block_start:text", "content_block_delta:text_delta", "content_block_stop",
      "content_block_start:server_tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:web_search_tool_result", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(out.filter((e) => e.type === "content_block_start").map((e) => e.index)).toEqual([0, 1, 2, 3]);
  });

  it("closes an open tool_use block before the search blocks, and only once", () => {
    const out = run([
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "\"Hanoi\"}" } }] }),
      chunk({ grounding_metadata: GROUNDING }),
      chunk({}, "tool_calls"),
    ]);
    expect(shape(out)).toEqual([
      "message_start",
      "content_block_start:tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:server_tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:web_search_tool_result", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(out.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual([0, 1, 2]);
    expect(JSON.parse(out[2].delta.partial_json)).toEqual({ city: "Hanoi" });
  });

  it("puts trailing grounding before message_delta and message_stop on a search request", () => {
    const gem = (parts, extra = {}) => ({ response: { candidates: [{ content: { role: "model", parts }, ...extra }], responseId: "r1", modelVersion: "gemini-x" } });
    const upstream = [
      gem([{ text: "Top story is" }]),
      gem([{ text: "" }], { finishReason: "STOP" }),
      gem([], { groundingMetadata: GROUNDING }),
    ];
    const state = { ...initState(FORMATS.CLAUDE), webSearchRequested: true };
    const out = upstream.flatMap((c) => translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, c, state) || []);
    out.push(...(translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, null, state) || []));
    expect(shape(out)).toEqual([
      "message_start",
      "content_block_start:text", "content_block_delta:text_delta", "content_block_stop",
      "content_block_start:server_tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:web_search_tool_result", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(out.find((e) => e.type === "message_delta").usage.server_tool_use.web_search_requests).toBe(2);
  });

  it("closes a search-request stream at end of stream when no grounding came", () => {
    const gem = (parts, extra = {}) => ({ response: { candidates: [{ content: { role: "model", parts }, ...extra }] } });
    const state = { ...initState(FORMATS.CLAUDE), webSearchRequested: true };
    const out = [gem([{ text: "hi" }]), gem([{ text: "" }], { finishReason: "STOP" })]
      .flatMap((c) => translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, c, state) || []);
    expect(out.some((e) => e.type === "message_stop")).toBe(false);
    const tail = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, null, state);
    expect(shape(tail)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
    expect(tail[1].usage).not.toHaveProperty("server_tool_use");
  });

  it("emits the search blocks once even if metadata repeats", () => {
    const out = run([chunk({ content: "x" }), chunk({ grounding_metadata: GROUNDING }), chunk({ grounding_metadata: GROUNDING }, "stop")]);
    expect(out.filter((e) => e.content_block?.type === "server_tool_use")).toHaveLength(1);
  });

  it("builds a non-stream message with the search blocks before the text", () => {
    const msg = openAICompletionToClaudeMessage({
      id: "chatcmpl-1", model: "m",
      choices: [{ message: { role: "assistant", content: "answer", grounding_metadata: GROUNDING }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(msg.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(msg.content[1].tool_use_id).toBe(msg.content[0].id);
    expect(msg.usage.server_tool_use.web_search_requests).toBe(2);
  });

  it("adds no server_tool_use when ungrounded", () => {
    const msg = openAICompletionToClaudeMessage({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
    expect(msg.content.map((b) => b.type)).toEqual(["text"]);
    expect(msg.usage).not.toHaveProperty("server_tool_use");
    const out = run([chunk({ content: "hi" }), chunk({}, "stop")]);
    expect(out.find((e) => e.type === "message_delta").usage).not.toHaveProperty("server_tool_use");
  });

  it("drops server_tool_use and web_search_tool_result from history without tool messages", () => {
    const body = {
      model: "x", max_tokens: 100,
      messages: [
        { role: "user", content: "search" },
        { role: "assistant", content: [
          { type: "server_tool_use", id: "srvtoolu_x", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_x", content: [{ type: "web_search_result", url: "https://example.com/a", title: "A" }] },
          { type: "text", text: "earlier answer" },
        ] },
        { role: "user", content: "and more?" },
      ],
    };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", body);
    expect(out.messages.some((m) => m.role === "tool" || m.tool_calls)).toBe(false);
    expect(JSON.stringify(out.messages)).toContain("earlier answer");
    expect(() => translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", structuredClone(body))).not.toThrow();
  });

  it("end to end: Claude web_search request, grounded Gemini stream, Claude blocks", () => {
    const req = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", {
      model: "x", max_tokens: 100, messages: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    expect(req.request.tools.at(-1)).toEqual({ googleSearch: {} });

    const gem = (parts, extra = {}) => ({ response: { candidates: [{ content: { role: "model", parts }, ...extra }], responseId: "r1", modelVersion: "gemini-x" } });
    const upstream = [
      gem([{ text: "Top story is" }]),
      gem([{ text: "" }], { finishReason: "STOP", groundingMetadata: GROUNDING }),
    ];
    const state = initState(FORMATS.CLAUDE);
    const out = upstream.flatMap((c) => translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, c, state) || []);
    const types = out.filter((e) => e.content_block).map((e) => e.content_block.type);
    expect(types).toEqual(["text", "server_tool_use", "web_search_tool_result"]);
    expect(out.find((e) => e.type === "message_delta").usage.server_tool_use.web_search_requests).toBe(2);
  });
});

describe("held finish released at end of stream", () => {
  const gem = (parts, extra = {}, usageMetadata) => ({
    response: { candidates: [{ content: { role: "model", parts }, ...extra }], responseId: "r1", modelVersion: "gemini-x", ...(usageMetadata && { usageMetadata }) },
  });
  const upstream = (withUsage) => [
    gem([{ text: "Top story is X" }]),
    gem([{ text: "" }], { finishReason: "STOP" }, withUsage ? { promptTokenCount: 40, candidatesTokenCount: 12, totalTokenCount: 52 } : undefined),
  ];

  async function runPipe(clientFormat, body, chunks) {
    const encoder = new TextEncoder();
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
    const input = new ReadableStream({ start(c) { c.enqueue(encoder.encode(sse)); c.close(); } });
    let completedUsage = null;
    const onComplete = (_content, usage) => { completedUsage = usage; };
    const out = input.pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.ANTIGRAVITY, clientFormat, "antigravity", null, null, "gemini-3.8-flash-medium", null, body, onComplete,
    ));
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const events = text.split("\n").filter((l) => l.startsWith("data: ") && l.slice(6).trim() !== "[DONE]").map((l) => JSON.parse(l.slice(6)));
    return { events, completedUsage };
  }

  const claudeBody = (tools) => ({ model: "x", max_tokens: 100, messages: [{ role: "user", content: "search" }], ...(tools && { tools }) });
  const searchTools = [{ type: "web_search_20250305", name: "web_search" }];

  it("pads and filters the Claude message_delta usage like a normal finish", async () => {
    const held = await runPipe(FORMATS.CLAUDE, claudeBody(searchTools), upstream(true));
    const plain = await runPipe(FORMATS.CLAUDE, claudeBody(), upstream(true));
    const heldDelta = held.events.find((e) => e.type === "message_delta");
    const plainDelta = plain.events.find((e) => e.type === "message_delta");
    expect(held.events.at(-1).type).toBe("message_stop");
    expect(heldDelta.usage).toEqual(plainDelta.usage);
    expect(heldDelta.usage.input_tokens).toBeGreaterThan(40); // padded, not the raw upstream count
    expect(held.completedUsage).toEqual(plain.completedUsage);
  });

  it("pads the OpenAI finish chunk usage like a normal finish", async () => {
    const body = (tools) => ({ messages: [{ role: "user", content: "search" }], ...(tools && { tools }) });
    const held = await runPipe(FORMATS.OPENAI, body([{ type: "web_search" }]), upstream(true));
    const plain = await runPipe(FORMATS.OPENAI, body(), upstream(true));
    const finish = (r) => r.events.find((e) => e.choices?.[0]?.finish_reason);
    expect(finish(held).usage).toEqual(finish(plain).usage);
    expect(held.completedUsage).toEqual(plain.completedUsage);
  });

  it("end to end: Claude web_search request through translateRequest, trailing grounding before message_stop", async () => {
    // chatCore hands the stream the same body object it passed to translateRequest.
    const body = claudeBody(searchTools);
    const req = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", body);
    expect(req.request.tools).toEqual([{ googleSearch: {} }]);
    expect(body.tools).toEqual(searchTools);

    const { events } = await runPipe(FORMATS.CLAUDE, body, [...upstream(true), gem([], { groundingMetadata: GROUNDING })]);
    expect(shape(events)).toEqual([
      "message_start",
      "content_block_start:text", "content_block_delta:text_delta", "content_block_stop",
      "content_block_start:server_tool_use", "content_block_delta:input_json_delta", "content_block_stop",
      "content_block_start:web_search_tool_result", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(events.find((e) => e.type === "message_delta").usage.server_tool_use.web_search_requests).toBe(2);
  });

  it("estimates usage for the held finish when upstream sent none", async () => {
    // Unwrapped Gemini chunks: stream.js counts their text for the estimate.
    const noUsage = upstream(false).map((c) => c.response);
    const held = await runPipe(FORMATS.CLAUDE, claudeBody(searchTools), noUsage);
    const plain = await runPipe(FORMATS.CLAUDE, claudeBody(), noUsage);
    const usage = held.events.find((e) => e.type === "message_delta").usage;
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBe(plain.events.find((e) => e.type === "message_delta").usage.output_tokens);
    expect(held.completedUsage).not.toBeNull();
  });
});
