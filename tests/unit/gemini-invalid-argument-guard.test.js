import { describe, it, expect } from "vitest";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { toFunctionCallArgs } from "open-sse/translator/formats/gemini.js";
import { describeGeminiRequestShape } from "open-sse/utils/geminiRequestShape.js";

function historyWithArgs(argumentsString) {
  return {
    model: "gemini-3.8-flash-high",
    stream: true,
    messages: [
      { role: "user", content: "read it" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: argumentsString } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "next" },
    ],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { p: { type: "string" } } } } }],
  };
}

function functionCallArgs(result) {
  return result.request.contents.flatMap(c => c.parts).find(p => p.functionCall).functionCall.args;
}

describe("functionCall args are always a JSON object", () => {
  it.each([
    ["truncated JSON", "{\"p\":\"/a"],
    ["JSON array", "[1,2]"],
    ["JSON string", "\"text\""],
    ["JSON null", "null"],
  ])("replays %s tool arguments as an empty object", (_label, args) => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-high", historyWithArgs(args), true, { projectId: "p" }, "antigravity");
    expect(functionCallArgs(out)).toEqual({});
  });

  it("keeps valid object arguments", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-high", historyWithArgs("{\"p\":\"/a\"}"), true, { projectId: "p" }, "antigravity");
    expect(functionCallArgs(out)).toEqual({ p: "/a" });
  });

  it("accepts already-parsed objects", () => {
    expect(toFunctionCallArgs({ a: 1 })).toEqual({ a: 1 });
    expect(toFunctionCallArgs(undefined)).toEqual({});
  });
});

describe("describeGeminiRequestShape", () => {
  it("returns null for non-Gemini bodies", () => {
    expect(describeGeminiRequestShape({ messages: [] })).toBeNull();
  });

  it("summarizes structure without leaking content", () => {
    const body = {
      request: {
        contents: [
          { role: "user", parts: [{ text: "secret prompt" }] },
          { role: "model", parts: [{ functionCall: { id: "c1", name: "read", args: { path: "/secret" } }, thoughtSignature: "SIG" }] },
          { role: "user", parts: [{ functionResponse: { id: "c1", name: "read", response: { result: "secret file" } } }] },
        ],
        tools: [{ functionDeclarations: [{ name: "read" }] }],
        toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
      },
    };
    const shape = describeGeminiRequestShape(body);
    expect(shape).toContain("contents=3 tools=1");
    expect(shape).toContain("fc(read,id=c1,args=object)+sig(3)");
    expect(shape).toContain("anomalies: none detected");
    expect(shape).not.toContain("secret");
  });

  it("flags anomalies that cause INVALID_ARGUMENT", () => {
    const body = {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [
            { functionCall: { id: "a", name: "read", args: null } },
            { functionCall: { id: "b", name: "read", args: {} } },
          ] },
          { role: "user", parts: [{ functionResponse: { id: "x", name: "read", response: {} } }] },
          { role: "user", parts: [] },
        ],
      },
    };
    const shape = describeGeminiRequestShape(body);
    expect(shape).toContain("#1 fc read args=null");
    expect(shape).toContain("#2 fr count 1 != fc count 2 in #1");
    expect(shape).toContain("#3 has no parts");
    expect(shape).toContain("#3 repeats role user");
  });
});
