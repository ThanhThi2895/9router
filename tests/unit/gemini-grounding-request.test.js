import { describe, it, expect } from "vitest";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { geminiToOpenAIRequest } from "open-sse/translator/request/gemini-to-openai.js";
import { openaiToGeminiRequest } from "open-sse/translator/request/openai-to-gemini.js";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";
import { requestsWebSearch } from "open-sse/translator/concerns/webSearch.js";

const fn = { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } };
const geminiBody = (tools) => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }], tools });
const searchCount = (tools) => (tools || []).filter(t => t.type === "web_search").length;

describe("gemini grounding request leg", () => {
  it("maps google_search / googleSearch to one hosted web_search, keeping functions", () => {
    for (const tool of [{ google_search: {} }, { googleSearch: {} }]) {
      const out = geminiToOpenAIRequest("m", geminiBody([tool]), true);
      expect(out.tools).toEqual([{ type: "web_search" }]);
    }
    const mixed = geminiToOpenAIRequest("m", geminiBody([{ googleSearch: {} }, { google_search: {} }, { functionDeclarations: [fn] }]), true);
    expect(searchCount(mixed.tools)).toBe(1);
    expect(mixed.tools.some(t => t.function?.name === "get_weather")).toBe(true);
  });

  it("sends googleSearch alone, and drops it when function declarations exist", () => {
    const base = { messages: [{ role: "user", content: "hi" }] };
    const only = openaiToGeminiRequest("m", { ...base, tools: [{ type: "web_search" }] }, true);
    expect(only.tools).toEqual([{ googleSearch: {} }]);
    const mixed = openaiToGeminiRequest("m", { ...base, tools: [{ type: "web_search_preview" }, { type: "function", function: fn }] }, true);
    expect(mixed.tools).toHaveLength(1);
    expect(mixed.tools[0].functionDeclarations[0].name).toBe("get_weather");
  });

  it("applies the same mixed-tool rule to gemini, gemini-cli and antigravity targets", () => {
    const base = { messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search" }, { type: "function", function: fn }] };
    const gemini = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-3.8-flash", structuredClone(base));
    const cli = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI_CLI, "gemini-3.8-flash", structuredClone(base));
    const ag = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", structuredClone(base));
    for (const tools of [gemini.tools, cli.request.tools, ag.request.tools]) {
      expect(tools).toHaveLength(1);
      expect(tools[0].functionDeclarations.map(d => d.name)).toEqual(["get_weather"]);
    }
    expect(cli.request.toolConfig).toBeDefined();
    const cliOnly = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI_CLI, "gemini-3.8-flash", { ...base, tools: [{ type: "web_search" }] });
    expect(cliOnly.request.tools).toEqual([{ googleSearch: {} }]);
    expect(cliOnly.request.toolConfig).toBeUndefined();
  });

  it("sets toolConfig on the antigravity envelope only with function declarations", () => {
    const base = { messages: [{ role: "user", content: "hi" }] };
    const only = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", { ...base, tools: [{ type: "web_search" }] });
    expect(only.request.tools).toEqual([{ googleSearch: {} }]);
    expect(only.request.toolConfig).toBeUndefined();
    const mixed = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", { ...base, tools: [{ type: "web_search" }, { type: "function", function: fn }] });
    expect(mixed.request.toolConfig).toBeDefined();
  });

  it("detects a web search request in every client body shape", () => {
    expect(requestsWebSearch({ tools: [{ type: "web_search" }] })).toBe(true);
    expect(requestsWebSearch({ tools: [{ google_search: {} }] })).toBe(true);
    expect(requestsWebSearch({ request: { tools: [{ googleSearch: {} }] } })).toBe(true);
    expect(requestsWebSearch({ tools: [{ type: "web_search_20250305", name: "web_search" }] })).toBe(true);
    expect(requestsWebSearch({ tools: [{ type: "function", function: fn }] })).toBe(false);
    expect(requestsWebSearch({})).toBe(false);
  });

  const claudeBody = () => ({
    model: "x", max_tokens: 100,
    messages: [{ role: "user", content: "search" }],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } },
    ],
  });

  it("turns a Claude web_search server tool into googleSearch for Antigravity", () => {
    const body = { ...claudeBody(), tools: claudeBody().tools.slice(0, 1) };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", body);
    expect(out.request.tools).toEqual([{ googleSearch: {} }]);
    expect(out.request.toolConfig).toBeUndefined();
  });

  it("keeps only the client functions when a Claude web_search tool comes with them", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-medium", claudeBody());
    const groups = out.request.tools;
    expect(groups).toHaveLength(1);
    expect(groups[0].functionDeclarations.map(d => d.name)).toEqual(["get_weather"]);
  });

  it("drops a tool_choice that named the removed search tool", () => {
    const body = { ...claudeBody(), tool_choice: { type: "tool", name: "web_search" } };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.GEMINI, "gemini-3.8-flash", body);
    expect(JSON.stringify(out)).not.toContain('"name":"web_search"');
  });

  it("leaves Claude -> OpenAI translation unchanged", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", claudeBody());
    expect(out.tools.map(t => t.function.name)).toEqual(["web_search", "get_weather"]);
    expect(out.tools.some(t => t.type === "web_search")).toBe(false);
  });

  it("maps Claude web_search to a hosted tool for zed Gemini models only", () => {
    const zed = (model) => translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, model, claudeBody(), true, null, "zed");
    const gemini = zed("gemini-3-pro");
    expect(gemini.tools.map(t => t.type)).toEqual(["function", "web_search"]);
    expect(gemini.tools.some(t => t.function?.name === "web_search")).toBe(false);
    const gpt = zed("gpt-5");
    expect(gpt.tools.map(t => t.function.name)).toEqual(["web_search", "get_weather"]);
  });

  const exec = (tools) => new AntigravityExecutor().transformRequest("gemini-3.8-flash-medium", {
    request: { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools },
  }, true, { projectId: "p", accessToken: "t" });

  it("executor: search-only keeps googleSearch with no toolConfig", () => {
    const out = exec([{ googleSearch: {} }]);
    expect(out.request.tools).toEqual([{ googleSearch: {} }]);
    expect(out.request.toolConfig).toBeUndefined();
  });

  it("executor: googleSearch is dropped when function declarations exist", () => {
    const out = exec([{ functionDeclarations: [fn] }, { googleSearch: {} }]);
    expect(out.request.tools).toHaveLength(1);
    expect(out.request.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(out.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
  });

  it("executor: no-search body still gets the reason placeholder and toolConfig", () => {
    const out = exec([{ functionDeclarations: [{ name: "noop" }] }]);
    expect(out.request.tools[0].functionDeclarations[0].parameters.required).toEqual(["reason"]);
    expect(out.request.toolConfig).toBeDefined();
  });
});
