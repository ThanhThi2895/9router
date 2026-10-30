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
| AC 8, live `/v1/messages` `stream:false` on the VPS | **NOT VERIFIED**: it needs the fix deployed first, and deploying was ruled out for this run |

Behavior note: a Responses-API client with `stream:false` behind a Gemini-family, Claude or Ollama upstream now gets `object:"response"` instead of `chat.completion` (the accepted side effect in the plan; covered by a test).

Remaining for the lead: deploy, then run the two live calls from phase 02 step 3 (no tools, and `web_search_20250305`).
