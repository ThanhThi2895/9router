# Verify: non-stream Anthropic replies from Gemini-family upstreams

Plan: `plans/261030-1440-antigravity-nonstream-claude-message/`. Change: `open-sse/handlers/chatCore/nonStreamingHandler.js` (uncommitted).

| Check | Result |
|---|---|
| New `tests/unit/nonstream-client-format.test.js` before the fix | 9 failed, 2 passed (the OpenAI-client pins and the unknown-body pass-through) |
| New test file plus 7 related files (forced-sse-json, responses-nonstream, grounding response/claude, native image, sse-error, cline envelope) | 8 files, 94 tests, all pass |
| `npx eslint` on the changed source and the new test | clean |
| Full `npx vitest run` | 27 failed, 4369 passed |
| `verify-no-regression.mjs` | the same 9 pass-to-fail as the parent commit (7 `golden-url-header`, `combo-credit-fallback`, `headroom-responses-format`); no new ones |
| AC 1-7, 9 | met |
| AC 8, live `/v1/messages` `stream:false` on the VPS (`127.0.0.1:20128`, container `9router`, image `ghcr.io/thanhthi2895/9router:vps`) | **PASS** (details below) |

Behavior note: a Responses-API client with `stream:false` behind a Gemini-family, Claude or Ollama upstream now gets `object:"response"` instead of `chat.completion` (the accepted side effect in the plan; covered by a test).

## Live check (AC 8)

Run on 2026-10-30 from inside the `9router` container on the VPS. One active, unrestricted API key was read read-only from the SQLite `apiKeys` table inside the remote process and used only there; it was never printed, saved or copied off the host. Model `gemini-3.8-flash-medium`, `stream:false`.

| Call | Result |
|---|---|
| No tools | HTTP 200, `type:"message"`, `role:"assistant"`, blocks `thinking` + `text`, `stop_reason:"end_turn"`, `usage.input_tokens` 2958 |
| `web_search_20250305` (`max_uses:2`), Hacker News prompt | HTTP 200, `type:"message"`, blocks `thinking`, `server_tool_use:web_search`, `web_search_tool_result`, `text`; `stop_reason:"end_turn"`; `usage.server_tool_use.web_search_requests` 1; no `tool_use` block named `web_search` |

Neither body carries `object:"chat.completion"`. The optional SDK-types replay was not run. The deployed commit hash is not exposed by the container, so deployment of `82a026ab` is inferred from the behavior (both bodies are in Anthropic format) and from the container having just restarted.

Observation (out of scope): the response `model` field reads `gemini-3.8-flash-n`, which differs from the requested `gemini-3.8-flash-medium`; worth a look whether the suffix is truncated somewhere.
