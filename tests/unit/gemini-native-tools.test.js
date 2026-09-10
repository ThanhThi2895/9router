import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Gemini-native endpoint used to convert requests with a local, partial
 * converter that dropped `tools` entirely, so an agent client (Gemini CLI,
 * Antigravity CLI) declared its tools, never got a functionCall back, and looped
 * forever re-asking the same question. These tests pin the four directions that
 * have to survive the hop: declarations up, tool results up, calls back down in
 * a stream, and calls back down in a plain JSON response.
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

const RUN_COMMAND = {
  name: "run_command",
  description: "Run a shell command",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

function geminiRequest(path, body, headers = {}) {
  return new Request(`https://router.test/v1beta/models/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function authorizedRequest(path, body) {
  return geminiRequest(path, body, { Authorization: "Bearer router-client-key" });
}

/** The body handleChat received, parsed. */
async function capturedChatBody() {
  expect(mocks.handleChat).toHaveBeenCalledTimes(1);
  return await mocks.handleChat.mock.calls[0][0].json();
}

/** Stand in for handleChat returning an OpenAI SSE stream of the given chunks. */
function openaiStream(chunks) {
  const body = new ReadableStream({
    start(controller) {
      const encode = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encode.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encode.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Collect the Gemini SSE payloads the endpoint emitted. */
async function readGeminiSSE(response) {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getModelAliases.mockResolvedValue({});
  mocks.handleChat.mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

describe("Gemini native endpoint — tool calls", () => {
  it("forwards tool declarations to the chat pipeline", async () => {
    await POST(
      authorizedRequest("ag/gemini-3.8-flash:generateContent", {
        contents: [{ role: "user", parts: [{ text: "run git status" }] }],
        tools: [{ functionDeclarations: [RUN_COMMAND] }],
      }),
      { params: Promise.resolve({ path: ["ag", "gemini-3.8-flash:generateContent"] }) }
    );

    const sent = await capturedChatBody();
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0]).toMatchObject({
      type: "function",
      function: { name: "run_command" },
    });
  });

  it("forwards a prior tool call and its result as a paired exchange", async () => {
    await POST(
      authorizedRequest("ag/gemini-3.8-flash:generateContent", {
        contents: [
          { role: "user", parts: [{ text: "run git status" }] },
          {
            role: "model",
            parts: [{ functionCall: { name: "run_command", args: { command: "git status" } } }],
          },
          {
            role: "user",
            parts: [{ functionResponse: { name: "run_command", response: { result: "clean" } } }],
          },
        ],
        tools: [{ functionDeclarations: [RUN_COMMAND] }],
      }),
      { params: Promise.resolve({ path: ["ag", "gemini-3.8-flash:generateContent"] }) }
    );

    const sent = await capturedChatBody();
    const assistant = sent.messages.find((message) => message.tool_calls);
    const toolResult = sent.messages.find((message) => message.role === "tool");

    expect(assistant.tool_calls[0].function.name).toBe("run_command");
    // The pairing is what providers validate: same id on the call and the result.
    expect(toolResult.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it("reassembles streamed tool-call fragments into one functionCall", async () => {
    mocks.handleChat.mockResolvedValue(
      openaiStream([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                function: { name: "run_command", arguments: '{"comm' },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"git status"}' } }] },
            finish_reason: null,
          }],
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ])
    );

    const response = await POST(
      authorizedRequest("ag/gemini-3.8-flash:streamGenerateContent", {
        contents: [{ role: "user", parts: [{ text: "run git status" }] }],
        tools: [{ functionDeclarations: [RUN_COMMAND] }],
      }),
      { params: Promise.resolve({ path: ["ag", "gemini-3.8-flash:streamGenerateContent"] }) }
    );

    const events = await readGeminiSSE(response);
    const parts = events.flatMap((event) => event.candidates?.[0]?.content?.parts ?? []);
    const call = parts.find((part) => part.functionCall);

    expect(call.functionCall).toEqual({ name: "run_command", args: { command: "git status" } });
    expect(events.at(-1).usageMetadata.totalTokenCount).toBe(15);
  });

  it("emits tool calls from a non-streaming response", async () => {
    mocks.handleChat.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "ag/gemini-3.8-flash",
          choices: [{
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } },
                { id: "call_2", type: "function", function: { name: "run_command", arguments: '{"command":"pwd"}' } },
              ],
            },
            finish_reason: "tool_calls",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await POST(
      authorizedRequest("ag/gemini-3.8-flash:generateContent", {
        contents: [{ role: "user", parts: [{ text: "list files" }] }],
        tools: [{ functionDeclarations: [RUN_COMMAND] }],
      }),
      { params: Promise.resolve({ path: ["ag", "gemini-3.8-flash:generateContent"] }) }
    );

    const payload = await response.json();
    const calls = payload.candidates[0].content.parts.filter((part) => part.functionCall);

    // Two distinct calls, not one call with both argument strings glued together.
    expect(calls.map((part) => part.functionCall.args.command)).toEqual(["ls", "pwd"]);
  });
});

describe("Gemini native endpoint — client credentials", () => {
  it("accepts the x-goog-api-key header Gemini clients send", async () => {
    await POST(
      geminiRequest(
        "ag/gemini-3.8-flash:generateContent",
        { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        { "x-goog-api-key": "router-client-key" }
      ),
      { params: Promise.resolve({ path: ["ag", "gemini-3.8-flash:generateContent"] }) }
    );

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(mocks.handleChat.mock.calls[0][0].headers.get("Authorization")).toBe(
      "Bearer router-client-key"
    );
  });

  it("leaves an Authorization header the client already set alone", async () => {
    await POST(
      geminiRequest(
        "ag/gemini-3.8-flash:generateContent",
        { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        { Authorization: "Bearer explicit-key", "x-goog-api-key": "other-key" }
      ),
      { params: Promise.resolve({ path: ["ag", "gemini-3.8-flash:generateContent"] }) }
    );

    expect(mocks.handleChat.mock.calls[0][0].headers.get("Authorization")).toBe(
      "Bearer explicit-key"
    );
  });
});
