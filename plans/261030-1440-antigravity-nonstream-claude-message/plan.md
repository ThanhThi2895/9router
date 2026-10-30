---
title: Non-stream Anthropic replies from Gemini-family upstreams
description: Render non-streaming Gemini/Antigravity replies into the client's format, so /v1/messages stream:false returns an Anthropic message instead of an OpenAI chat.completion.
status: pending
priority: P1
effort: 2h
branch: master
tags: [bug, backend, api, translator]
blockedBy: []
blocks: []
created: 2026-10-30
mode: fast (root cause verified in source)
---

# Non-stream Anthropic replies from Gemini-family upstreams

## Outcome
An Anthropic client that calls `/v1/messages` with `stream:false` and is routed to Antigravity (or any Gemini-family upstream) gets a real Anthropic `message`: `type:"message"`, `content[]` blocks, Anthropic `stop_reason`, and `usage.input_tokens` / `usage.output_tokens`. When the reply is grounded, the content also holds `server_tool_use` and `web_search_tool_result` blocks, and the usage holds `server_tool_use.web_search_requests`.

Evidence of the bug: `plans/reports/verify-261030-1430-gemini-grounding.md`, concern 1 (live on the VPS at commit 5c622000, `gemini-3.8-flash-medium`, reproduced with no tools in the request).

## Root cause (verified in source, 2026-10-30)
Antigravity is not `forceStream`, so `stream:false` sends `v1internal:generateContent` (`open-sse/executors/antigravity.js:171`) and `chatCore.js:535` hands the JSON reply to `handleNonStreamingResponse`.

`translateNonStreamingResponse(responseBody, targetFormat, sourceFormat)` in `open-sse/handlers/chatCore/nonStreamingHandler.js` takes `targetFormat` as the provider format and `sourceFormat` as the client format. It converts the provider body into an OpenAI `chat.completion` and stops there:

| Line | Branch | What happens |
|---|---|---|
| 100-109 | `targetFormat === OPENAI` | The only branch that renders to the client. It converts to Responses (`openAICompletionToResponses`) or Claude (`openAICompletionToClaudeMessage`). |
| 111-178 | Gemini / Antigravity / Gemini CLI / Vertex | Builds an OpenAI `chat.completion` and returns it, whatever `sourceFormat` is. The early `if (!response?.candidates?.[0]) return responseBody;` also returns an already-OpenAI body (for example one that came from the SSE branch) without rendering it. |
| 180-234 | Claude upstream | Same: returns OpenAI shape. |
| 236-238 | Ollama | Same. |

So a Claude client gets `chat.completion`. Then `filterUsageForFormat(usage, CLAUDE)` (`open-sse/utils/usageTracking.js:59`) keeps only Claude usage keys, and an OpenAI usage has none of them, so the client also loses its token counts. The grounding fields (`annotations`, `grounding_metadata`) survive on `message`, which matches the report.

The Anthropic renderer is already correct and tested: `openAICompletionToClaudeMessage` (`open-sse/translator/concerns/claudeMessage.js:16`) emits the search blocks and `usage.server_tool_use` from `message.grounding_metadata` (`gemini-grounding-claude.test.js`). It just never runs on this path.

## Design
Split `translateNonStreamingResponse` into two steps that every branch shares:
1. **Provider → OpenAI.** The existing Gemini-family, Claude and Ollama branches, unchanged, produce an OpenAI `chat.completion`. The early returns that mean "this is not a provider body I recognise" (the `candidates` guard, the Claude `choices` guard) pass the body on to step 2 instead of returning.
2. **OpenAI → client.** One local helper renders the OpenAI body for `sourceFormat`: `CLAUDE` → `openAICompletionToClaudeMessage`, `OPENAI_RESPONSES` → `openAICompletionToResponses(body, customToolNames)`, anything else → unchanged. The `targetFormat === OPENAI` branch uses the same helper, so there is one rendering path.

`openAICompletionToClaudeMessage` and `openAICompletionToResponses` already return the body unchanged when it has no `choices[0]`, so a body neither step understands still passes through as it does today.

**Accepted side effect, tested:** a Responses-API client (`/v1/responses`, `stream:false`) routed to a Gemini-family or Claude upstream now gets an `object:"response"` body instead of `chat.completion`. It is the same defect with the same one-line cause, and the renderer already exists. A Claude client behind an Ollama upstream is fixed the same way.

No change to `handleNonStreamingResponse`: it already detects `type:"message"` and `object:"response"` and skips the Chat-Completions post-processing for them, and `filterUsageForFormat(…, CLAUDE)` keeps `server_tool_use`.

## Constraints
- OpenAI-format clients get byte-identical output for every upstream. A test pins it.
- The `targetFormat === OPENAI` behavior stays the same for every client format (existing tests in `openai-responses-nonstream.test.js` and `claude-forced-sse-json.test.js` must pass unchanged).
- Stay inside `nonStreamingHandler.js`. No new translator files, no streaming changes, no executor changes.
- Use `FORMATS` and schema constants, no string literals for formats or block types.

## Non-goals
- Streaming paths (already correct per the verify report).
- `handleForcedSSEToJson`: it already renders Claude and Responses clients.
- Gemini-native clients (`/v1beta`): they reach `handleChat` with an OpenAI body, so `sourceFormat` is `openai`.
- Gemini cache-token accounting (`cachedContentTokenCount`) in the OpenAI usage. A separate gap.
- Anthropic text `citations`, and the order of search blocks versus text (phase 04 of the grounding plan already chose it).

## Phases
| # | Phase | Depends on | Files |
|---|---|---|---|
| 01 | [Render non-stream replies to the client format](phase-01-render-to-client-format.md) | none | `open-sse/handlers/chatCore/nonStreamingHandler.js`, `tests/unit/nonstream-client-format.test.js` (new) |
| 02 | [Verify and changelog](phase-02-verify-and-changelog.md) | 01 | `CHANGELOG.md`, a report under `plans/reports/` |

## Acceptance criteria
1. `translateNonStreamingResponse(antigravityBody, ANTIGRAVITY, CLAUDE)` returns `type:"message"`, `role:"assistant"`, a `text` block, `stop_reason:"end_turn"`, and `usage.input_tokens` / `usage.output_tokens` from `usageMetadata`. Same for `GEMINI`, `GEMINI_CLI` and `VERTEX` targets.
2. With `groundingMetadata` on the candidate, the message holds `server_tool_use` and `web_search_tool_result` blocks with matching ids, at least one `web_search_result`, `usage.server_tool_use.web_search_requests >= 1`, and no `tool_use` named `web_search`.
3. A `functionCall` part becomes a `tool_use` block and `stop_reason:"tool_use"`.
4. `handleNonStreamingResponse` with `sourceFormat: CLAUDE`, `targetFormat: ANTIGRAVITY` and a JSON upstream returns a body with `type:"message"`, non-zero `usage.input_tokens` (not dropped by `filterUsageForFormat`), `usage.server_tool_use` when grounded, and no `object` / `choices` fields.
5. An already-OpenAI body with `targetFormat: ANTIGRAVITY` and `sourceFormat: CLAUDE` is rendered as a Claude message, not returned raw.
6. `sourceFormat: OPENAI` output is deep-equal to the pre-change output for Antigravity, Claude and Ollama upstreams.
7. `sourceFormat: OPENAI_RESPONSES` with an Antigravity upstream returns `object:"response"` with the text in `output`.
8. Live: `/v1/messages` `stream:false` on the VPS with `gemini-3.8-flash-medium`, once with no tools and once with `web_search_20250305`, returns an Anthropic message (AC 2 of the grounding plan, the row marked NOT VERIFIED). Runs only after the lead deploys.
9. `node tests/__baseline__/verify-no-regression.mjs` reports no new failures against the 9 pre-existing ones listed in the verify report.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| A client that relied on the wrong `chat.completion` shape from `/v1/messages` breaks | low | No Anthropic SDK can parse that shape; the streaming path already returns Anthropic events. Changelog entry calls it out. |
| A provider whose "Claude-format" target actually returns OpenAI JSON (xiaomi-tokenplan, per the comment at line 188) now gets rendered for Claude clients | low, and it is the correct result | Test 6 pins OpenAI clients; Claude clients there were getting the wrong shape too. |
| Pass-through guards change behavior for unknown bodies | low | Both renderers return the body unchanged when there is no `choices[0]`. A test pins an unknown body passing through untouched. |

## Security notes
- Response-shape change only. No new outbound requests, no auth, credential, `X-Forwarded-For` or rate-limit code touched, no SSRF surface.
- Grounding URLs and titles keep flowing into JSON values only, through the existing renderer.
- The phase 02 live check reads the API key inside the remote shell and never prints or stores it, as the earlier verify run did.

## Open questions
None blocking. Whether to run the live check (AC 8) depends on the lead deploying the fix to the VPS.
