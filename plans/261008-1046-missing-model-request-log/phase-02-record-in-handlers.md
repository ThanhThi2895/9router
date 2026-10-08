# Phase 2 — Record from request handlers

## Context
All six handlers share the same shape: parse body → auth → `if (!modelStr)` → `getModelInfo` → credentials loop → core call → `result.success` / fallback. `result` from cores has `{ success, status, error, response }` (`open-sse/utils/error.js:99`).

## Files
- Create `src/sse/services/unresolvedModel.js`:
  - `recordUnresolvedModel({ request, endpoint, requestedModel, reason, provider, error })` — derives `endpoint` from `new URL(request.url).pathname` when not given, `userAgent` from headers; calls the repo function without `await`, wrapped in try/catch.
  - `isModelNotFoundError(status, message)` — `true` for 404, or for 400/422 when the message matches a config-driven pattern list (e.g. `/model.*(not[ _-]?found|does not exist|unknown|invalid|not supported)/i`, `/no such model/i`, `/unknown model/i`). Keep the patterns in one exported constant.
- Modify `src/sse/handlers/chat.js`, `embeddings.js`, `tts.js`, `stt.js`, `imageGeneration.js`, `systemone.js`. At each site, add one call next to the existing `log.warn`, without changing the response:
  - `Missing model` → reason `missing_model`, `requestedModel: ""`.
  - `Invalid model format` → `invalid_model_format`.
  - `No active credentials for provider` (first try only) → `no_credentials`, with `provider`.
  - After a failed core call: if `isModelNotFoundError(result.status, result.error)` → `upstream_model_not_found` with `provider` and `requestedModel` = the client-facing model string (`provider/model`). Record once per request, before fallback decisions, so multi-account loops on the same 404 produce a single hit per account at most; acceptable, since `count` is informative only.
- `stt.js` and `tts.js` have their own lookups (`getCustomModels`, `AI_PROVIDERS`); add the call wherever they reject an unknown model in the same way.

## Notes
- Combo members flow through `handleSingleModelChat`, so a broken member of a combo is recorded with its own model string. Record the combo name in `lastError` context is not needed (KISS).
- `requestedModel` for chat should be the original `body.model` after `[1m]` stripping (use `modelStr`).
- Do not record for bypass/warmup requests (they return before model resolution).

## Validation
Manual: run dev server on 20128, send `curl` requests for each reason, wait 5s, query the table. Automated tests in phase 4.

## Risk / rollback
Fail-open helper; the only behavioural risk is an exception at the call site, prevented by try/catch inside the helper. Rollback = remove the calls.
