import { describe, it, expect } from "vitest";
import { translateRequest, translateResponse, initState } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";

// Antigravity client (agy / IDE via MITM) routed to a non-antigravity Gemini provider:
// antigravity → openai → gemini, then gemini → openai → antigravity.
describe("antigravity client ↔ gemini provider tool-call round-trip", () => {
  it("returns functionCall id and upstream thoughtSignature to the client", () => {
    const state = { ...initState(FORMATS.ANTIGRAVITY), sessionId: "sess-rt-1" };
    const chunk = {
      response: {
        responseId: "r1", modelVersion: "gemini-3-pro",
        candidates: [{
          content: { role: "model", parts: [{ functionCall: { id: "fc_rt_1", name: "view_file", args: { AbsolutePath: "/a.py" } }, thoughtSignature: "SIG_UPSTREAM" }] },
          finishReason: "STOP",
        }],
      },
    };
    const out = translateResponse(FORMATS.GEMINI, FORMATS.ANTIGRAVITY, chunk, state);
    const part = out.flatMap(r => r.response.candidates[0].content.parts).find(p => p.functionCall);
    expect(part.functionCall.id).toBe("fc_rt_1");
    expect(part.thoughtSignature).toBe("SIG_UPSTREAM");
  });

  it("keeps client signatures and pairs id-less calls with their own results", () => {
    const body = {
      model: "gemini-3-pro", userAgent: "antigravity",
      request: {
        sessionId: "sess-rt-2",
        contents: [
          { role: "user", parts: [{ text: "read both" }] },
          { role: "model", parts: [{ functionCall: { name: "view_file", args: { AbsolutePath: "/a.py" } }, thoughtSignature: "SIG_A" }] },
          { role: "user", parts: [{ functionResponse: { name: "view_file", response: { output: "A" } } }] },
          { role: "model", parts: [{ functionCall: { name: "view_file", args: { AbsolutePath: "/b.py" } }, thoughtSignature: "SIG_B" }] },
          { role: "user", parts: [{ functionResponse: { name: "view_file", response: { output: "B" } } }] },
        ],
        tools: [{ functionDeclarations: [{ name: "view_file", description: "v", parameters: { type: "OBJECT", properties: { AbsolutePath: { type: "STRING" } } } }] }],
      },
    };
    const out = translateRequest(FORMATS.ANTIGRAVITY, FORMATS.GEMINI, "gemini-3-pro", body, true, {}, "gemini");
    const calls = out.contents.flatMap(c => c.parts).filter(p => p.functionCall);
    const results = out.contents.flatMap(c => c.parts).filter(p => p.functionResponse);

    expect(calls.map(p => p.thoughtSignature)).toEqual(["SIG_A", "SIG_B"]);
    expect(new Set(calls.map(p => p.functionCall.id)).size).toBe(2);
    expect(results.map(p => p.functionResponse.id)).toEqual(calls.map(p => p.functionCall.id));
    expect(results.map(p => p.functionResponse.response.result.output)).toEqual(["A", "B"]);
  });
});
