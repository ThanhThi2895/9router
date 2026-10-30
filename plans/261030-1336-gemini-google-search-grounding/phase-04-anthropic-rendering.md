---
phase: 04
title: Anthropic web_search rendering
status: pending
effort: 2h
depends_on: [02, 03]
---

# Phase 04: Anthropic web_search rendering

## Goal
An Anthropic client that sent a `web_search_*` server tool gets Anthropic-shaped search output from a grounded Gemini reply. That means a `server_tool_use` block, a `web_search_tool_result` block, and `usage.server_tool_use.web_search_requests`, both streamed and non-streamed.

## Files
| Action | Path | Change |
|---|---|---|
| modify | `open-sse/translator/concerns/webSearch.js` | Add `groundingToClaudeBlocks(gm, idSeed)` → `[serverToolUse, webSearchToolResult]`, plus `groundingQueryCount(gm)`. |
| modify | `open-sse/translator/response/openai-to-claude.js` | When `delta.grounding_metadata` is present and `!state.webSearchEmitted`: `stopThinkingBlock`, `stopTextBlock`, then emit start/stop events for both blocks with `state.nextBlockIndex++`. Set `state.webSearchEmitted` and `state.webSearchRequests`. On finish, add `server_tool_use: { web_search_requests }` to the `message_delta` usage. |
| modify | `open-sse/translator/concerns/claudeMessage.js` | `openAICompletionToClaudeMessage`: if `message.grounding_metadata` is present, put the two blocks before the text block (non-stream has the whole answer, so the order can match Anthropic's) and set `usage.server_tool_use`. |
| modify | `open-sse/translator/schema/blocks.js` | Add `CLAUDE_WEB_SEARCH = { TOOL_NAME: "web_search", RESULT_ITEM: "web_search_result", TOOL_USE_ID_PREFIX: "srvtoolu_" }`. `SERVER_TOOL_USE` and `WEB_SEARCH_TOOL_RESULT` already exist. |

## Block shapes
```js
{ type: "server_tool_use", id: "srvtoolu_<24 base62>", name: "web_search", input: { query: queries[0] || "" } }
{ type: "web_search_tool_result", tool_use_id: <same id>,
  content: sources.map(s => ({ type: "web_search_result", url: s.url, title: s.title, encrypted_content: "", page_age: null })) }
```
- Deduplicate sources by URL in a `Map`, keeping first-seen order (same approach as `chatSearch.js:136`).
- Streaming events for `server_tool_use` follow Anthropic: `content_block_start` with `input: {}`, then an `input_json_delta` carrying `{"query":…}`, then `content_block_stop`. For `web_search_tool_result`, the full block goes in `content_block_start`, followed by `content_block_stop`.
- Use one `server_tool_use` even when `webSearchQueries` has several entries, because Gemini does not tie chunks to queries. `web_search_requests` is still `max(1, queries.length)`.
- Make the id with `crypto.randomUUID()`, base62-trimmed to match the Anthropic prefix. It must not be derived from upstream data.
- Ignore `annotations` here. `grounding_metadata` is the only input.

## History round-trip (follow-up turns)
`claude-to-openai.js` (switch at line 172) has no case for `server_tool_use` or `web_search_tool_result`, so these blocks are dropped from history. That is the intended behavior: the model sees its own earlier text answer. Pin it with a test instead of adding code.

## Tests (new `tests/unit/gemini-grounding-claude.test.js`)
1. Stream: a grounded OpenAI chunk sequence (from phase 03 test 1 output) through `openaiToClaudeResponse` produces events in this order: text start/delta/stop, `server_tool_use` start/delta/stop, `web_search_tool_result` start/stop, `message_delta` with `stop_reason:"end_turn"` and `usage.server_tool_use.web_search_requests >= 1`. Block indexes increase by one each time.
2. Stream: thinking, then text, then grounding closes both open blocks before the search blocks.
3. Non-stream: `openAICompletionToClaudeMessage` gives `content` = `[server_tool_use, web_search_tool_result, text]`, and the `tool_use_id` matches the `server_tool_use` id.
4. Ungrounded regression: the existing `openai-to-claude.test.js` and `openai-to-claude-response-tools.test.js` pass, and there is no `server_tool_use` key in usage.
5. History: `translateRequest(CLAUDE, ANTIGRAVITY, …)` with an assistant turn holding `server_tool_use`, `web_search_tool_result` and `text`, followed by a user turn → it does not throw, and there are no `tool_calls` or `role:"tool"` messages in the OpenAI intermediate.
6. End-to-end in-process: Claude body with `web_search_20250305` → `translateRequest` → assert the hosted tool. Then the fixture upstream stream → `translateResponse(ANTIGRAVITY, CLAUDE, …)` → assert the blocks.

## Validation
```bash
cd tests && npx vitest run unit/gemini-grounding-claude.test.js unit/openai-to-claude.test.js unit/openai-to-claude-response-tools.test.js
```

## Risk and rollback
The renderer runs only when `grounding_metadata` is present, so other Claude-format traffic is unaffected. Revert the three files to roll back.
