// Client-facing SSE responses must tell nginx-style reverse proxies not to buffer,
// or a proxy with default proxy_buffering holds every event until the stream ends.
import { describe, it, expect, vi } from "vitest";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { SSE_HEADERS_CORS } from "../../open-sse/utils/sseConstants.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

describe("SSE proxy buffering header", () => {
  it("SSE_HEADERS_CORS disables nginx proxy buffering", () => {
    expect(SSE_HEADERS_CORS["X-Accel-Buffering"]).toBe("no");
  });

  it("chat streaming response carries X-Accel-Buffering: no", async () => {
    const frame = `data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    const providerResponse = new Response(new TextEncoder().encode(frame), {
      headers: { "content-type": "text/event-stream" },
    });
    const { response } = await handleStreamingResponse({
      providerResponse,
      provider: "openai",
      model: "gpt-x",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [] },
      stream: true,
      requestStartTime: Date.now(),
      streamController: createStreamController({ provider: "openai", model: "gpt-x" }),
    });
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await response.text();
  });
});
