---
title: Gemini Google Search grounding pass-through
description: Forward Google Search grounding to Gemini-family upstreams and return the grounding to Gemini, OpenAI and Anthropic clients.
status: pending
priority: P2
effort: 11h
branch: master
tags: [feature, backend, api, translator]
blockedBy: []
blocks: []
created: 2026-10-30
mode: auto (hard, red-team folded into the plan)
---

# Gemini Google Search grounding pass-through

## Outcome
A client can make a Gemini model served through 9router search the web, and it gets back the sources and queries.

- **Minimum:** a native `/v1beta/models/{model}:generateContent` or `:streamGenerateContent` request with `tools:[{google_search:{}}]` (or `googleSearch`) reaches Antigravity as `googleSearch`. The response carries `candidates[0].groundingMetadata` with `webSearchQueries`, `groundingChunks` and `groundingSupports`.
- **Ideal:** an Anthropic `/v1/messages` request with a `web_search_20250305` (or `web_search_20260209`) server tool runs upstream as `googleSearch`. The model answers with text plus a `server_tool_use` block and a `web_search_tool_result` block listing the sources. It no longer returns a client `tool_use` named `web_search` with input `{reason}`.
- **Side effect we accept and test:** OpenAI chat `tools:[{type:"web_search"}]` / `{type:"google_search"}` sent to a Gemini-family target also grounds. Sources come back as standard `message.annotations[]` of type `url_citation`.

## Root cause (verified in source, 2026-10-30)
Grounding is dropped at four points. Every one of them has to be fixed for the minimum outcome.

| # | Where | What drops it |
|---|---|---|
| 1 | `open-sse/translator/request/gemini-to-openai.js:54-70` | Only `tool.functionDeclarations` is converted. `google_search` and `googleSearch` are discarded on the `/v1beta` Gemini→OpenAI hop. |
| 2 | `open-sse/translator/request/openai-to-gemini.js:280-307` | Only `function` tools and Claude-shaped tools become `functionDeclarations`. A hosted `{type:"web_search"}` is discarded. |
| 3 | `open-sse/executors/antigravity.js:286-309` | Every tool group is rebuilt into one `functionDeclarations` group, so any `googleSearch` group is lost. Line 305 is also where the `{reason: string}` placeholder schema comes from. It fills in any tool that has no schema, which explains the bogus `web_search {reason}` call. Line 337 forces `toolConfig.functionCallingConfig.mode = VALIDATED` whenever `tools` is non-empty. |
| 4 | `open-sse/translator/response/gemini-to-openai.js` | `candidate.groundingMetadata` is never read. Even a grounded upstream reply would reach every client without sources. |

On the Anthropic path, `claude-to-openai.js:67-74` maps every tool to an OpenAI function. A `web_search_20250305` tool has no `input_schema`, so it becomes the function `web_search` with empty parameters, and drop point 3 then gives it the `{reason}` schema.

Existing proof that Antigravity grounding works: `/v1/search` with provider `antigravity` (`open-sse/handlers/search/chatSearch.js:104-163`) sends `tools:[{googleSearch:{}}]` to `v1internal:generateContent` with `requestType:"search"` and model `gemini-2.5-flash`, and it parses `groundingMetadata`. It is unproven whether the **agent/chat** path (no `requestType`, model `gemini-3.8-flash-*`) grounds the same way. Phase 01 settles that before any code changes.

## Design
Carry grounding through the existing OpenAI pivot instead of adding a direct `gemini:antigravity` route. The `/v1beta` route already calls `handleChat` with an OpenAI body, so the request goes through the pivot whatever the source format.

**Request carrier: the OpenAI hosted tool `{type:"web_search"}`.** This is the honest OpenAI spelling of a provider-run search, and `filterToOpenAIFormat` already passes unknown tools through untouched.
- Gemini source (`/v1beta`): `{google_search:{}}` / `{googleSearch:{}}` → `{type:"web_search"}`.
- Anthropic source: `web_search_YYYYMMDD` server tools become `{type:"web_search"}`, **but only when the target format is Gemini-family** (`gemini`, `gemini-cli`, `antigravity`). This is done in `translateRequest` around step 1: the server tools are pulled out before `claude→openai` and the hosted tool is appended after it. Every other target keeps today's behavior byte-for-byte. This avoids sending a hosted tool type to OpenAI-compatible providers that would reject it.
- OpenAI → Gemini (`openaiToGeminiBase`): `{type:"web_search"|"web_search_preview"|"google_search"}` → a separate `{googleSearch:{}}` group after the `functionDeclarations` group. Deduplicate to one.
- Antigravity executor: keep the `googleSearch` group next to the merged `functionDeclarations` group. Send `toolConfig` only when function declarations exist. Phase 01 decides the policy when both are present.

**Response carrier: two fields on the OpenAI delta and message.**
- `annotations: [{type:"url_citation", url_citation:{url, title, start_index?, end_index?}}]`. This is the standard OpenAI chat shape, so OpenAI clients read it natively.
- `grounding_metadata`: the raw Gemini `groundingMetadata` object, copied without changes. It is a 9router extension field. It lets `/v1beta` rebuild `groundingMetadata` without loss (queries, supports, `searchEntryPoint`), and it gives the Claude renderer the queries.
- `gemini-to-openai` keeps the latest `groundingMetadata` in state and attaches both fields to the finish chunk. If grounding arrives after the finish chunk, it goes out as its own chunk. The forced-SSE→JSON aggregator and the non-stream Gemini branch copy both fields onto `message`.

**Consumers**
- `openai-to-antigravity` (used by `/v1beta` for both stream and JSON): `grounding_metadata` → `candidate.groundingMetadata`.
- `openai-to-claude` (stream) and `openAICompletionToClaudeMessage` (JSON): when grounding is present, close any open text block. Then emit one `server_tool_use` `{id:"srvtoolu_…", name:"web_search", input:{query}}` and one `web_search_tool_result` `{tool_use_id, content:[{type:"web_search_result", url, title, encrypted_content:"", page_age:null}]}`, and set `usage.server_tool_use.web_search_requests` to the number of queries. Gemini sends grounding at the end of the stream, so these blocks come **after** the text. The order is documented and tested. Text `citations` are not produced, because Anthropic's `web_search_result_location` needs an `encrypted_index` that Gemini has no equivalent for.

Constants (`web_search`, `googleSearch`, `server_tool_use`, the web_search type pattern) live in `open-sse/translator/schema/`, following the repo convention. Shared mapping code lives in one new concern module, `open-sse/translator/concerns/webSearch.js`.

## Constraints
- Byte-identical behavior for requests with no search tool and for non-Gemini-family targets. Every phase has a regression test that pins this.
- No server-side fetching of grounding URLs, so no new SSRF surface. Grounding `uri`s are often `vertexaisearch.cloud.google.com/grounding-api-redirect/…` links and are passed through as-is.
- Upstream data goes into `Map`s or plain arrays, never into object keys chosen from upstream values (same rule as `chatSearch.js:136`).
- Phase 01 probes must never print or write OAuth tokens. They read the account from the local DB and redact it in every log.
- No `/v1/responses` output changes (`web_search_call` items, `output_text.annotations`). See non-goals.

## Non-goals
- `/v1/responses` structured search output. The request may start grounding as a side effect, but rendering `web_search_call` items is a follow-up.
- Vertex (`openai-to-vertex.js`) and Claude models served through Antigravity (`openaiToClaudeRequestForAntigravity`). For those, the hosted tool is dropped quietly, which is better than today's bogus client tool.
- Anthropic text `citations` with `web_search_result_location`.
- Resolving grounding redirect URLs to their final URLs.
- The "always streams even when `stream` is false" behavior noted in the evidence report.
- A gateway-run tool loop that executes `web_search` through `/v1/search` when upstream refuses to mix tools. If phase 01 shows mixing is refused, that becomes a separate plan.

## Phases
| # | Phase | Depends on | Files |
|---|---|---|---|
| 01 | [Live probe of Antigravity grounding](phase-01-live-probe.md) | none | Scratchpad scripts and a findings report only. The scrubbed fixtures are inlined later into the phase 03 and 04 tests, because the repo has no `tests/unit/fixtures/` directory. |
| 02 | [Request leg](phase-02-request-leg.md) | 01 | `concerns/webSearch.js` (new), `schema/blocks.js`, `translator/index.js`, `request/gemini-to-openai.js`, `request/openai-to-gemini.js`, `executors/antigravity.js` |
| 03 | [Response carrier + /v1beta](phase-03-response-carrier.md) | 01 | `response/gemini-to-openai.js`, `response/openai-to-antigravity.js`, `chatCore/sseToJsonHandler.js`, `chatCore/nonStreamingHandler.js`, `src/app/api/v1beta/models/[...path]/route.js` |
| 04 | [Anthropic rendering](phase-04-anthropic-rendering.md) | 02, 03 | `response/openai-to-claude.js`, `concerns/claudeMessage.js` |
| 05 | [End-to-end verification + docs](phase-05-verify-and-docs.md) | 02–04 | tests, `CHANGELOG.md`, `open-sse/AGENTS.md` (only if the carrier convention needs a line) |

Phases 02 and 03 touch disjoint files and can run in parallel after 01. Phase 04 imports helpers from `concerns/webSearch.js`, which phase 02 creates. If 02 and 03 run in parallel, phase 02 owns that file and phase 03 adds its response helpers there only after phase 02 lands.

## Acceptance criteria
1. A native `/v1beta` request for `gemini-3.8-flash-medium` with `tools:[{google_search:{}}]` returns non-empty text and `groundingMetadata.groundingChunks.length > 0`, on both `:generateContent` and `:streamGenerateContent`. This is checked live in phase 05 against the HN ground-truth prompt from the evidence report.
2. An Anthropic `/v1/messages` request with `tools:[{type:"web_search_20250305", name:"web_search", max_uses:2}]` returns `stop_reason: "end_turn"`, a `server_tool_use` block, a `web_search_tool_result` block with at least one `web_search_result`, and no `tool_use` named `web_search`. Checked both streaming and non-streaming.
3. OpenAI chat with `tools:[{type:"web_search"}]` to the same model returns non-empty content and at least one `url_citation` annotation.
4. A request with no search tool produces the same upstream body as before. Pinned by snapshot tests on the translated Antigravity body for an OpenAI, Claude and Gemini source.
5. A Claude-source request to a non-Gemini-family target (for example `openai` / a `default` executor provider) produces the same translated body as before.
6. A follow-up turn whose history contains `server_tool_use` and `web_search_tool_result` blocks translates without throwing and without inventing orphan tool calls.
7. `node tests/__baseline__/verify-no-regression.mjs` reports no new failures. The provider and alias baselines are unchanged.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| The Antigravity agent path ignores `googleSearch` for `gemini-3.8-flash-*`, or only honors it with `requestType:"search"` | medium | Phase 01 probes this first. If only `search` works, the executor sets `requestType:"search"` **only** when the request carries `googleSearch` and no function declarations. The 429-bucket note at `antigravity.js:347-353` says the `search` bucket is unaffected. |
| Upstream rejects `googleSearch` mixed with `functionDeclarations` (Gemini 2.x did) | medium | Phase 01 probes it. The fallback policy is to keep the functions, drop `googleSearch`, and log once at debug. Claude Code's WebSearch tool sends a sub-request whose only tool is the server tool, so the main client still works. |
| `functionCallingConfig: VALIDATED` with no declarations gives a 400 | high if not handled | Send `toolConfig` only when function declarations exist (phase 02). |
| Claude clients expect the search blocks before the text | low | Phase 05 runs a real Anthropic SDK parse. If a client breaks on the order, buffer text when the request carried the server tool (noted as an option, not planned). |
| The `grounding_metadata` extension field breaks a strict OpenAI client | low | OpenAI SDKs ignore unknown fields. It appears only on grounded responses. |

## Security notes
- No new outbound fetches. Grounding URLs are relayed, never dereferenced.
- No change to auth, credential storage, `X-Forwarded-For` handling, or rate limiting.
- Phase 01 handles live OAuth tokens. Scripts stay in the session scratchpad, read tokens from the local DB, and redact them in output. Captured fixtures are scrubbed of `project`, `sessionId`, and account email before they are committed.
- Upstream strings (titles, URLs, queries) flow into JSON values only, never into object keys or log format strings.

## Open questions
None blocking. Two decisions are deferred to phase 01 evidence (requestType and mixed-tool policy), and each phase records its result.
