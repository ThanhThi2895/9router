# Code review: missing-model request log (pending changes)

Plan: `plans/261008-1046-missing-model-request-log/plan.md`
Branch: `thinguyen/feat/missing-model-log` (uncommitted working tree vs `HEAD` 45b4ff3f)
Verdict: one medium correctness issue should be fixed before merge. Security posture is acceptable.

## Verification performed
- New tests: `npx vitest run unit/missing-models-route.test.js unit/unresolved-model-recording.test.js unit/unresolved-models-repo.test.js` gave 3 files and 12 tests passing.
- Full suite plus `verify-no-regression.mjs`: the working tree reports 61 "pass→fail" entries. A clean `HEAD` worktree run through the same gate also reports exactly the same 61, so there are **no new failures** from this change. The gate is red because `known-fails.txt` is stale, not because of this branch. AC8 is met in substance, but the gate does not pass as a command.
- Auth: `/api/usage/missing-models` is not in `PUBLIC_API_PATHS` (`src/dashboardGuard.js:23`) and falls under the deny-by-default `/api/*` branch. AC6 is met.
- Recording happens after the `requireApiKey` check in every handler, so unauthenticated remote callers cannot write rows when API keys are enforced.

## Findings

### 1. Medium: the model-not-found classifier labels ordinary 400 errors as `upstream_model_not_found`
`src/sse/services/unresolvedModel.js:4`. The pattern `/model.*(…|invalid|…)/i` matches any message where "model" appears anywhere before "invalid". A probe against realistic upstream 400 bodies returned true for:
- `This model's maximum context length is 8192 tokens … Invalid request.` (context overflow, the most common 400)
- `[400]: model gpt-4o: Invalid type for messages[2].content`
- `model: claude-x … invalid_request_error`. Raw JSON error bodies carry `"type":"invalid_request_error"`, so most 400s that mention the model will match.

Impact: the dashboard fills with false "missing model" entries for models that work. That defeats the purpose of the feature. Separately, any bare 404 counts (`unresolvedModel.js:11`), including a wrong `baseUrl` on a custom or compatible node. That second part is accepted by the plan, but it is worth knowing.
Fix: drop the bare `invalid` and `unknown` alternatives from the greedy pattern. Match explicit phrases (`model_not_found`, `model not found`, `does not exist`, `no such model`, `unknown model`, `invalid model`) within a bounded span. Add negative tests for context-length and type-validation messages in `tests/unit/unresolved-model-recording.test.js`.

### 2. Low: one request is counted once per account attempt
404 is an account-scoped fallback status (`open-sse/services/accountFallback.js:57`). The `upstream_model_not_found` record sits inside the account loop (`src/sse/handlers/chat.js:320`, and the same placement in embeddings, imageGeneration, stt, tts and systemone). A single request with a bad model id against a provider with N connections therefore adds N to `count`. AC1 describes `count` as the number of repeated requests.
Fix: record once per request, either on the final failure path or with a per-request flag.

### 3. Low: the UI and some acceptance details drift slightly
- `MissingModelsTab.js:286`: first seen appears only as a hover tooltip, but AC6 lists first and last seen as visible columns.
- `MissingModelsTab.js:203`: "Clear all" is disabled when the current filtered view is empty. It also clears hidden resolved rows and rows of other reasons, while the confirm text gives no hint of that scope.
- `MissingModelsTab.js:136-137`: clearing from page > 1 fetches twice, and the explicit call uses the stale page. This is harmless.

### 4. Low: test gap for the handler wiring
No test drives a real handler (chat, embeddings, tts, stt, image, systemone) to confirm the reason recorded, unchanged status codes, or fail-open behaviour when the repo throws. AC1 to AC4 are covered only through the helper and the repo. One parametrised handler test per reason would close the gap.

## Security notes
- No API key, Authorization header, cookie or body is stored. Fields are truncated (model 200, UA 200, error 500) and rendered as React text with no `dangerouslySetInnerHTML`.
- `lastError` stores upstream error text verbatim, up to 500 characters. Some providers echo partial key prefixes in auth errors, but those are 401s and are not recorded. Today's 404 and 400 model errors do not echo secrets. Keep it that way if the classifier is broadened.
- Write amplification is bounded by the 500-row cap and the 5-second or 50-item buffered flush. Eviction is by oldest `lastSeen`.
- The shutdown handler copies the existing `requestDetailsRepo` pattern, including SIGINT and SIGTERM listeners. It introduces no new behaviour.

## Not issues (checked)
- Migration 002 uses `CREATE TABLE IF NOT EXISTS` and coexists with the additive TABLES sync. The `SCHEMA_VERSION` bump triggers the pre-migration backup.
- Clear and delete running alongside a flush: after its single `await getAdapter()`, the flush runs synchronously, so a cleared row cannot be re-inserted from a stale batch.
- The `verify-no-regression.mjs` path normalisation is backward compatible with `/app/` paths.

## Unresolved questions
- Should the plan's open question (lower priority for `no_credentials` on a known but unconnected provider) be settled before merge, or left to the reason filter?
- Should `known-fails.txt` be refreshed (61 stale entries) so that the regression gate is usable again? That is outside this change's scope.
