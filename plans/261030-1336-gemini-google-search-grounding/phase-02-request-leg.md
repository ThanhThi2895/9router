---
phase: 02
title: Request leg
status: pending
effort: 3h
depends_on: [01]
---

# Phase 02: Request leg

## Goal
A search tool from any client format reaches the Gemini-family upstream as `googleSearch`. Requests without a search tool, and Claude-source requests to non-Gemini-family targets, translate exactly as before.

## Files
| Action | Path | Change |
|---|---|---|
| modify | `open-sse/translator/schema/blocks.js` | Add `OPENAI_HOSTED_TOOL = { WEB_SEARCH: "web_search", WEB_SEARCH_PREVIEW: "web_search_preview" }`, `GEMINI_TOOL = { GOOGLE_SEARCH: "googleSearch", GOOGLE_SEARCH_SNAKE: "google_search" }`, and `CLAUDE_WEB_SEARCH_TYPE_PREFIX = "web_search_"`. Add them to the explicit export list in `schema/index.js`, which re-exports names one by one. The barrel holds data only, so the `/^web_search_\d{8}$/` RegExp goes in the concern module. |
| create | `open-sse/translator/concerns/webSearch.js` | Request helpers (below). Phase 03 adds response helpers to the same file. |
| modify | `open-sse/translator/request/gemini-to-openai.js` | In the tools loop, a tool that has `googleSearch` or `google_search` pushes one `{type:"web_search"}` (deduplicated). |
| modify | `open-sse/translator/index.js` | In `translateRequest`, when `sourceFormat === CLAUDE` and `targetFormat` is Gemini-family, pull the server web-search tools out before step 1 and append the hosted tool after it. |
| modify | `open-sse/translator/request/openai-to-gemini.js` | In `openaiToGeminiBase`, hosted search tools add one `{googleSearch:{}}` group **after** the `functionDeclarations` group. In `wrapInCloudCodeEnvelope`, set `toolConfig` only when a `functionDeclarations` group exists. |
| modify | `open-sse/executors/antigravity.js` | In `transformRequest`, keep `googleSearch` groups. Set `toolConfig` only when declarations exist. Apply D1 and D2 from phase 01. |

## `concerns/webSearch.js` (request half)
```js
// Gemini-family targets run a hosted web search as googleSearch grounding.
export const GROUNDING_TARGETS = new Set([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY]);

export const isHostedWebSearchTool = (t) =>
  t?.type === OPENAI_HOSTED_TOOL.WEB_SEARCH || t?.type === OPENAI_HOSTED_TOOL.WEB_SEARCH_PREVIEW
  || t?.type === GEMINI_TOOL.GOOGLE_SEARCH_SNAKE;               // OpenAI-shaped {type:"google_search"}
export const isGeminiSearchTool = (t) => !!(t?.[GEMINI_TOOL.GOOGLE_SEARCH] || t?.[GEMINI_TOOL.GOOGLE_SEARCH_SNAKE]);
const CLAUDE_WEB_SEARCH_TYPE = new RegExp(`^${CLAUDE_WEB_SEARCH_TYPE_PREFIX}\\d{8}$`);   // web_search_20250305, web_search_20260209
export const isClaudeWebSearchTool = (t) => CLAUDE_WEB_SEARCH_TYPE.test(t?.type || "");

/** Remove Anthropic server web-search tools from a Claude body; returns whether any were present. */
export function takeClaudeWebSearchTools(body) { ... }   // mutates body.tools; deletes it if it ends up empty
/** Append one hosted web_search tool to an OpenAI body unless one is already there. */
export function addHostedWebSearchTool(body) { ... }
```
`max_uses`, `allowed_domains`, `blocked_domains` and `user_location` from the Anthropic tool are dropped, because `googleSearch` has no equivalent (Gemini's `excludeDomains` exists only on Vertex). Say so in a one-line comment.

## `translateRequest` change (exact placement)
```js
// before "Step 1: source -> openai"
const claudeWebSearch = sourceFormat === FORMATS.CLAUDE && GROUNDING_TARGETS.has(targetFormat)
  && takeClaudeWebSearchTools(result);
...
result = toOpenAI(model, result, stream, credentials);
if (claudeWebSearch) addHostedWebSearchTool(result);
```
This only runs in the pivot branch. Check that no direct route exists for `claude:{gemini,gemini-cli,antigravity}` (none is registered today). If a `tool_choice` named the removed tool (`{type:"tool", name:"web_search"}`), drop the `tool_choice` too, so the OpenAI hop does not point at a missing function.

## Executor change (`antigravity.js` `transformRequest`)
- While merging groups, set `wantsSearch = tools.some(isGeminiSearchTool)` and skip those groups in the declaration loop.
- `tools = [...(allDeclarations.length ? [{ functionDeclarations: allDeclarations }] : []), ...(wantsSearch && <D2 allows> ? [{ googleSearch: {} }] : [])]`.
- Gate `toolConfig` on `allDeclarations.length > 0`, not on `tools.length > 0`.
- D1: if the search bucket is required, set `requestType:"search"` only for search-only requests, after the existing `delete body.requestType`. Keep `buildIdeRequestId` on `"agent"` unless the probe shows the request id must match the bucket.
- The `{reason}` placeholder stays for real client functions without a schema. A search tool no longer reaches it.

## Tests (new `tests/unit/gemini-grounding-request.test.js`)
1. `geminiToOpenAIRequest` with `[{google_search:{}}]`, with `[{googleSearch:{}}]`, and mixed with `functionDeclarations` → exactly one `{type:"web_search"}` plus the functions.
2. `openaiToGeminiRequest` / `openaiToAntigravityRequest` with `{type:"web_search"}` → `tools` ends with `{googleSearch:{}}`. With no functions there is no `toolConfig`; with functions, `toolConfig` is present.
3. `translateRequest(CLAUDE, ANTIGRAVITY, "gemini-3.8-flash-medium", body with web_search_20250305 + one client tool)` → there is no function named `web_search`, the hosted tool is present, and the client tool is kept.
4. `translateRequest(CLAUDE, OPENAI, ...)` with the same body → output deep-equals the output captured on `master` before this change (snapshot taken in the test from a hard-coded expected object).
5. `AntigravityExecutor.transformRequest` with `[{functionDeclarations:[f]}, {googleSearch:{}}]` → the result follows D2, and `toolConfig` is set only when declarations remain.
6. No-search regression: the executor output for an existing tool-call fixture body (reuse one from `antigravity-tool-call-roundtrip.test.js`) is unchanged.

## Validation
```bash
cd tests && npx vitest run unit/gemini-grounding-request.test.js unit/gemini-native-tools.test.js unit/antigravity-tool-call-roundtrip.test.js unit/openai-to-claude-tools-no-type.test.js
```
All pass. Then run `node tests/__baseline__/verify-no-regression.mjs` and confirm there are no new failures.

## Risk and rollback
The change is limited to tools that match the search predicates. Revert the six files to roll back. There is no persisted state.
