# Gemini grounding: end-to-end verification (phase 05)

Target: deployed VPS container `9router` (source files byte-identical to commit 5c622000, checked by md5 of `gemini-to-openai.js`), called from inside the VPS against `http://127.0.0.1:20128`. Model `gemini-3.8-flash-medium` via antigravity. Phase 01 probe was skipped. The API key was read read-only from the VPS data dir inside the remote shell and never printed or stored; output below is trimmed.

Prompt: "Use Google Search to find the current #1 story on Hacker News front page."
Ground truth (HN Firebase API, same minute): top story "Binance-hacker-1029 – $5.6B stolen from Binance". Every grounded answer named that story, so the search was real.

| AC | Check | Result |
|----|-------|--------|
| 1 | `/v1beta ...:generateContent`, `tools:[{google_search:{}}]` | 200, text names top story, `groundingChunks` 2, `webSearchQueries` 2, `groundingSupports` 2. PASS |
| 1 | `:streamGenerateContent?alt=sse` | 200, 4 events, text names top story, `groundingChunks` 1. PASS |
| 3 | `/v1/chat/completions` `tools:[{type:"web_search"}]`, non-stream | content non-empty, 2 `url_citation` annotations, `grounding_metadata` present. PASS |
| 3 | same, stream | 7 events, 3 annotations. PASS |
| 2 | `/v1/messages` `web_search_20250305`, stream | blocks `text, server_tool_use, web_search_tool_result`, `stop_reason: end_turn`, `usage.server_tool_use.web_search_requests` 3, no `tool_use` named `web_search`. PASS |
| 2 | official `@anthropic-ai/sdk`, `messages.stream().finalMessage()` on a captured copy of that SSE (replayed through a local HTTP server; the key cannot leave the host) | parsed: stop `end_turn`, 3 `web_search_result`, `tool_use_id` matches. PASS |
| 2 | `/v1/messages` non-stream | NOT VERIFIED, see concern 1 |
| mixed | `web_search_20250305` + client tool `get_time`, stream | 200, model emitted `tool_use: get_time`; the request is accepted, no upstream 400 |
| 4-6 | unit tests | `gemini-grounding-{request,response,claude}.test.js`: 45 passed |

## Regression
- `eslint` on translator, antigravity executor, chatCore, v1beta: clean.
- `verify-alias.mjs`: equal (132 tokens).
- `verify-providers.mjs`: reports `sensenova` and `runcrate` as added. Both arrive from earlier provider commits (for example b9c27225), not from this feature.
- `verify-no-regression.mjs` on a full run: 9 pass-to-fail (7 in `translator/golden-url-header`, `unit/combo-credit-fallback`, `unit/headroom-responses-format`). The same 9 fail on the parent commit (5c622000~1), checked in a throwaway worktree, so none are caused by this feature.

## Concerns
1. Non-stream `/v1/messages` through antigravity returns an OpenAI `chat.completion` body (grounded `annotations` included), not an Anthropic `message`, even with no tools in the request. This reproduces without any search tool, so it is not caused by this change. It is the "always streams even when stream is false" area the plan lists as a non-goal. Anthropic clients that send `stream:false` get the wrong shape.
2. Run-to-run: the model answered with the right story each time, but cited URLs differ (the model picked `arkm.com` sources).
