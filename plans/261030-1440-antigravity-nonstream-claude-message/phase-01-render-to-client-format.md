---
phase: 01
title: Render non-stream replies to the client format
status: pending
effort: 1.5h
depends_on: []
---

# Phase 01: Render non-stream replies to the client format

## Goal
`translateNonStreamingResponse` always renders its OpenAI intermediate into the client's format, whichever upstream produced it.

## Files
| Action | Path | Change |
|---|---|---|
| modify | `open-sse/handlers/chatCore/nonStreamingHandler.js` | Add a local `renderForClient(openaiBody, sourceFormat, customToolNames)`. Route every branch of `translateNonStreamingResponse` through it. |
| create | `tests/unit/nonstream-client-format.test.js` | Tests below (test first). |

## Steps
1. Write the tests below and run them. Tests 1-5, 7 and 8 must fail on current code; 6 and 9 must pass.
2. In `nonStreamingHandler.js`, add above `translateNonStreamingResponse`:
   ```js
   // Render the OpenAI intermediate in the client's format. Every upstream
   // branch converts to OpenAI first; without this a Claude or Responses
   // client would get a raw chat.completion.
   function renderForClient(openaiBody, sourceFormat, customToolNames) {
     if (sourceFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(openaiBody);
     if (sourceFormat === FORMATS.OPENAI_RESPONSES) return openAICompletionToResponses(openaiBody, customToolNames);
     return openaiBody;
   }
   ```
3. Restructure `translateNonStreamingResponse`:
   - Keep `if (targetFormat === sourceFormat) return responseBody;`.
   - Move the current body of each provider branch into a `providerBodyToOpenAI(responseBody, targetFormat)` local function (same code, same order). `targetFormat === OPENAI` returns the body as is. The Gemini-family `candidates` guard and the Claude `choices` / non-array `content` guard return `responseBody` from this function, which then goes to step 4 instead of out to the client.
   - `translateNonStreamingResponse` becomes `return renderForClient(providerBodyToOpenAI(responseBody, targetFormat), sourceFormat, customToolNames);`.
   - Keep comments on the moved code. Do not change any conversion detail inside the branches.
4. Run the new test file, then `claude-forced-sse-json.test.js`, `openai-responses-nonstream.test.js`, `gemini-grounding-response.test.js`, `gemini-grounding-claude.test.js`, `gemini-native-image-output.test.js`, `nonstream-sse-error.test.js`, `cline-free-models-envelope.test.js`.
5. `npx eslint open-sse/handlers/chatCore/nonStreamingHandler.js tests/unit/nonstream-client-format.test.js`.

## Tests (`tests/unit/nonstream-client-format.test.js`)
Mock `@/lib/usageDb.js` the same way `antigravity-nonstream-usage-3260.test.js` does. Fixtures are inline. Use an Antigravity envelope `{ response: { candidates:[…], usageMetadata:{ promptTokenCount, candidatesTokenCount, totalTokenCount }, modelVersion, responseId } }`, and reuse the grounding fixture shape from `gemini-grounding-response.test.js` (`webSearchQueries`, `groundingChunks[].web.{uri,title}`, `groundingSupports`).
1. Antigravity → Claude, plain text: `type:"message"`, `content` is one `text` block, `stop_reason:"end_turn"`, `usage.input_tokens` / `output_tokens` equal the metadata counts.
2. Same body for `GEMINI`, `GEMINI_CLI`, `VERTEX` targets (unenveloped for `GEMINI`): `type:"message"`.
3. Antigravity → Claude, grounded: content holds `server_tool_use` (name `web_search`) and `web_search_tool_result` with `tool_use_id` equal to its id and at least one `web_search_result`; `usage.server_tool_use.web_search_requests >= 1`; no block is `tool_use` named `web_search`.
4. Antigravity → Claude, `functionCall` part: one `tool_use` block with the parsed args, `stop_reason:"tool_use"`.
5. Already-OpenAI body (`choices[0].message.content:"hi"`) with `targetFormat: ANTIGRAVITY`, `sourceFormat: CLAUDE`: rendered as a Claude message with text `hi`.
6. Regression pin: for `sourceFormat: OPENAI`, the output for an Antigravity body, a Claude body and an Ollama body equals a literal expected object written from current behavior (capture it before the change).
7. Antigravity → Responses: `object:"response"`, `output` holds a `message` item whose `output_text` is the text.
8. `handleNonStreamingResponse` end to end: `providerResponse = new Response(JSON.stringify(groundedBody), { headers: { "content-type": "application/json" } })`, `sourceFormat: CLAUDE`, `targetFormat: ANTIGRAVITY`, a stub `reqLogger` with no-op `logProviderResponse` / `logConvertedResponse`, no-op `trackDone` / `appendLog`. The JSON body has `type:"message"`, `usage.input_tokens > 0`, `usage.server_tool_use.web_search_requests >= 1`, and no `object` or `choices` key.
9. Unknown body (`{ foo: 1 }`) with `targetFormat: ANTIGRAVITY`, `sourceFormat: CLAUDE` comes back unchanged.

## Validation
```bash
cd tests && npx vitest run unit/nonstream-client-format.test.js unit/claude-forced-sse-json.test.js unit/openai-responses-nonstream.test.js unit/gemini-grounding-response.test.js unit/gemini-grounding-claude.test.js unit/gemini-native-image-output.test.js unit/nonstream-sse-error.test.js unit/cline-free-models-envelope.test.js
```
All pass.

## Rollback
Revert the single commit; the change is contained in one source file and one new test file.
