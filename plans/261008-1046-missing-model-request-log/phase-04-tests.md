# Phase 4 — Tests and regression check

## Files
- Create `tests/unit/unresolved-models-repo.test.js`:
  - repeated events with the same key aggregate into one row with summed `count`;
  - truncation of model/user agent/error;
  - cap at 500 evicts oldest `lastSeen`;
  - a resolved row hit again becomes unresolved;
  - repo works on the `sql.js` adapter (the always-available fallback).
- Create `tests/unit/unresolved-model-recording.test.js`:
  - `isModelNotFoundError` truth table (404, 400 with "model not found", 400 with unrelated message, 429, 500);
  - chat handler with mocked `getModelInfo`/credentials records `missing_model`, `invalid_model_format`, `no_credentials`, `upstream_model_not_found` and still returns the original status code and message;
  - recorder that throws does not change the handler response.
  Follow existing mocking style in `tests/unit/account-fallback-4xx.test.js`.

## Commands
```bash
cd tests && npx vitest run unit/unresolved-models-repo.test.js unit/unresolved-model-recording.test.js
cd tests && npx vitest run   # full run
node tests/__baseline__/verify-no-regression.mjs
npx eslint .
```

## Done when
New tests pass, the regression verifier reports no new failures versus `tests/__baseline__/known-fails.txt`, and lint is clean for touched files. Add a `CHANGELOG.md` entry under the next unreleased version (`feat(usage): log requests for missing or unroutable models`).
