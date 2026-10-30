---
phase: 05
title: End-to-end verification and docs
status: pending
effort: 1.5h
depends_on: [02, 03, 04]
---

# Phase 05: End-to-end verification and docs

## Goal
Prove acceptance criteria 1 to 7 against a running local 9router, then record the change.

## Steps
1. **Process hygiene:** check `lsof -i :20128` first. Reuse a running dev server for this checkout, or start one with `PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev` using the harness background run, and record its PID. Stop it at the end of the phase.
2. **Live checks.** Use the HN prompt from the evidence report and a local 9router API key, redacted in every log. Run each against `gemini-3.8-flash-medium` via the antigravity provider:
   - AC1: `/v1beta/models/<model>:generateContent` and `:streamGenerateContent?alt=sse` with `tools:[{google_search:{}}]` give non-empty text and `groundingChunks.length > 0`.
   - AC2: `/v1/messages` with `web_search_20250305` must return `server_tool_use`, `web_search_tool_result` and `stop_reason:"end_turn"`, with no `tool_use` named `web_search`. Run it both streaming and non-streaming, and parse it once with the official `@anthropic-ai/sdk`. The SDK is not a repo dependency, so install it into the session scratchpad and never into the repo, (`messages.create` and `messages.stream().finalMessage()`) to prove an SDK accepts the blocks and their order.
   - AC3: `/v1/chat/completions` with `tools:[{type:"web_search"}]` gives non-empty content and at least one `url_citation`.
   - Mixed tools: an Anthropic request with `web_search_20250305` and one client tool behaves the way phase 01 decision D2 says.
   - The answer's top story matches the HN Firebase API at the same moment. This proves the search is real and not a guess.
3. **Regression:**
   ```bash
   cd tests && npx vitest run unit/gemini-grounding-*.test.js
   node __baseline__/verify-no-regression.mjs
   node __baseline__/verify-providers.mjs && node __baseline__/verify-alias.mjs
   npx eslint open-sse/translator open-sse/executors/antigravity.js open-sse/handlers/chatCore "src/app/api/v1beta"
   ```
   There must be no new failures compared with `tests/__baseline__/known-fails.txt`.
4. **Docs:**
   - `CHANGELOG.md`: add one entry under the next root version: "feat(translator): pass Gemini Google Search grounding through `/v1beta`, Anthropic `web_search_*` and OpenAI `web_search` tools on Gemini-family providers".
   - `open-sse/AGENTS.md`: add one line under the translator conventions describing the carrier (the hosted `{type:"web_search"}` on requests, plus `annotations` and the `grounding_metadata` extension on responses), so future translators reuse it. Read the file first and put the line next to the existing pivot-format notes.
   - No `docs/ARCHITECTURE.md` change. The request lifecycle has not changed.

## Validation
- Every acceptance criterion in `plan.md` is checked off, with the command and a trimmed output excerpt (keys redacted) in `plans/reports/verify-261030-<HHMM>-gemini-grounding.md`.
- `git status` shows only the files listed in phases 02 to 05.
- The dev server that was started is stopped (`lsof -i :20128` is empty, or the server you reused is still the user's own).

## Rollback
Revert the feature commit(s). There are no migrations, settings or persisted data to undo.
