---
phase: 02
title: Verify and changelog
status: pending
effort: 0.5h
depends_on: [01]
---

# Phase 02: Verify and changelog

## Goal
Show the fix holds against the full suite and, once deployed, against the live upstream.

## Files
| Action | Path | Change |
|---|---|---|
| modify | `CHANGELOG.md` | One `fix(chat)` line under `# Unreleased` → `## Fixes`, using the `- **Chat**: …` style of the existing entries: non-streaming `/v1/messages` (and `/v1/responses`) routed to Gemini-family, Claude or Ollama upstreams now return the client's format instead of `chat.completion`. |
| create | `plans/reports/verify-261030-HHMM-nonstream-claude-message.md` | Results table. |

## Steps
1. Full suite and baseline: `cd tests && npx vitest run`, then `node tests/__baseline__/verify-no-regression.mjs`. The only pass-to-fail entries may be the 9 listed in `plans/reports/verify-261030-1430-gemini-grounding.md` (golden-url-header, combo-credit-fallback, headroom-responses-format).
2. `npx eslint open-sse/handlers/chatCore/`.
3. Live, only after the lead deploys the commit to the VPS (do not deploy from this phase). From inside the VPS against `http://127.0.0.1:20128`, with the key read inside the remote shell and never printed:
   - `/v1/messages`, `stream:false`, `gemini-3.8-flash-medium`, no tools: `type:"message"`, a `text` block, `stop_reason:"end_turn"`, `usage.input_tokens > 0`.
   - Same with `tools:[{type:"web_search_20250305", name:"web_search", max_uses:2}]` and the HN prompt from the earlier report: `server_tool_use` + `web_search_tool_result` blocks, `usage.server_tool_use.web_search_requests >= 1`, no `tool_use` named `web_search`.
   - Optional: parse the captured body with the official `@anthropic-ai/sdk` types (`messages.create` against a local replay server), as the earlier report did for the stream.
   If the deploy has not happened, mark AC 8 NOT VERIFIED in the report with the reason.
4. Write the report.
