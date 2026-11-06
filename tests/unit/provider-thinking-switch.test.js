// Regression: a provider-level thinking switch ("on"/"off") must not rewrite a
// client's own `thinking` into reasoning_effort "on"/"off". That effort string
// outranked the client's thinking and resolved antigravity Gemini requests to
// thinkingLevel "minimal" + includeThoughts:false, so no thinking text came back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logOpenAIRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const geminiReply = {
  response: {
    candidates: [{
      content: { role: "model", parts: [{ text: "Considering the greeting", thought: true }, { text: "Hello!" }] },
      finishReason: "STOP",
    }],
  },
};

async function send({ thinking, providerThinking }) {
  let sentBody;
  executeMock.mockImplementation(async ({ body }) => {
    sentBody = body;
    return {
      response: new Response(JSON.stringify(geminiReply), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://example.invalid",
      headers: {},
      transformedBody: body,
    };
  });
  const result = await handleChatCore({
    body: {
      model: "ag/gemini-3.8-flash-high",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      ...(thinking ? { thinking } : {}),
    },
    modelInfo: { provider: "antigravity", model: "gemini-3.8-flash-high" },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-conn",
    sourceFormatOverride: "claude",
    providerThinking,
    clientRawRequest: { endpoint: "/v1/messages", body: {}, headers: {} },
  });
  return { thinkingConfig: sentBody.request.generationConfig.thinkingConfig, result };
}

describe("provider-level thinking switch with client thinking", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const mode of ["on", "off"]) {
    it(`mode "${mode}" keeps thoughts for thinking:{type:"enabled"}`, async () => {
      const { thinkingConfig, result } = await send({ thinking: { type: "enabled" }, providerThinking: { mode } });
      expect(thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
      const message = JSON.parse(await result.response.text());
      expect(message.content[0]).toEqual({ type: "thinking", thinking: "Considering the greeting" });
    });

    it(`mode "${mode}" keeps thoughts for thinking with budget_tokens`, async () => {
      const { thinkingConfig } = await send({ thinking: { type: "enabled", budget_tokens: 4096 }, providerThinking: { mode } });
      expect(thinkingConfig.includeThoughts).toBe(true);
      expect(thinkingConfig.thinkingLevel).not.toBe("minimal");
    });
  }

  it(`mode "on" still injects thinking when the client sent none`, async () => {
    const { thinkingConfig } = await send({ providerThinking: { mode: "on" } });
    expect(thinkingConfig).toEqual({ thinkingLevel: "medium", includeThoughts: true });
  });
});
