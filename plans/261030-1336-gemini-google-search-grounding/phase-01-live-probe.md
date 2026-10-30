---
phase: 01
title: Live probe of Antigravity grounding
status: pending
effort: 1.5h
depends_on: []
---

# Phase 01: Live probe of Antigravity grounding

## Goal
Answer three questions with real upstream responses before any code changes. Then capture scrubbed response fixtures for the unit tests in phases 03 and 04.

1. **Agent path:** does `v1internal:streamGenerateContent` with the body the executor builds today (no `requestType`, model `gemini-3.8-flash-medium`), plus `tools:[{googleSearch:{}}]` and **no** `toolConfig`, return `groundingMetadata`? Repeat with `requestType:"search"`.
2. **Mixing:** does the same request with `tools:[{functionDeclarations:[…one trivial fn…]}, {googleSearch:{}}]` and `toolConfig.functionCallingConfig.mode:"VALIDATED"` succeed and ground? Repeat with mode `AUTO`.
3. **Shape:** where in the stream does `groundingMetadata` appear (which chunk, only on the finish chunk or also before, once or cumulative), and which fields are present (`webSearchQueries`, `groundingChunks[].web.{uri,title,domain}`, `groundingSupports`, `searchEntryPoint`)?

## Files
- Read: `open-sse/executors/antigravity.js` (`transformRequest`, `buildHeaders`, `buildUrl`), `open-sse/handlers/search/chatSearch.js:104-163`, `open-sse/providers/registry/antigravity.js`, `src/lib/db/repos/connectionsRepo.js`, `src/lib/db/paths.js`.
- Create: probe scripts in the session scratchpad only, never in the repo.
- Create: a short findings report at `plans/reports/probe-261030-<HHMM>-antigravity-grounding.md`.

## Steps
1. Load one active Antigravity connection through `src/lib/db/repos/connectionsRepo.js` (the same access path the app uses). Refresh its token through `AntigravityExecutor.refreshCredentials` if it has expired. Never print `accessToken`, `refreshToken`, `projectId` or `email`. Mask them as `<redacted>` in every log line.
2. Build each probe body by calling `new AntigravityExecutor().transformRequest(...)` on an OpenAI-translated body, then patching `request.tools` and `toolConfig` by hand for each variant. This way the probe sends exactly what the executor would send apart from the variable under test. Use the evidence report's prompt ("…current #1 story on Hacker News…") and check the answer against the HN Firebase API (`https://hacker-news.firebaseio.com/v0/topstories.json` then `/item/<id>.json`).
3. Run the variants as a matrix of agent vs `search` requestType, search-only vs mixed tools, and `VALIDATED` vs `AUTO`, at most 8 calls. Record status, whether grounding is present, chunk index, and the answer's top story.
4. Save one search-only stream and one non-stream (`:generateContent`) response with grounding. Scrub `responseId`, any project or session ids, and keep at most 3 grounding chunks. These become inline fixtures in the phase 03 and 04 tests.

## Decisions this phase records (write them into the findings report and into phase 02)
- **D1 requestType:** omit it (preferred) if the agent path grounds. Otherwise set `requestType:"search"` only when the request has `googleSearch` and no function declarations.
- **D2 mixing:** if mixing works, send both groups. If it fails, drop `googleSearch` when function declarations exist and log `ANTIGRAVITY googleSearch dropped: upstream rejects mixing with function tools` once at debug.
- **D3 toolConfig mode with mixing:** keep `VALIDATED` if it works, otherwise use the mode that works.
- **D4 grounding timing:** confirms or corrects the phase 03 rule (attach on the finish chunk, emit late arrivals on their own chunk).

## Validation
- The report has a filled matrix table and D1 to D4 answered with the call that proves each.
- `grep -ri "ya29\.\|1//0" <report> <fixtures>` returns nothing (no tokens leaked).
- No process is left running and no repo file has changed (`git status` is clean apart from the report).

## Rollback
Nothing to roll back. Delete the scratchpad scripts.

## If blocked
If no Antigravity account is available or every variant fails, stop. Report `BLOCKED` with the exact upstream error text. Phases 02 to 04 must not start on guesses, because D1 and D2 change the executor code.
