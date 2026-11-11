---
phase: 1
title: "Model-scoped all-locked error"
status: done
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Model-scoped all-locked error

## Goal

When every account is locked for the requested model, the 503 takes its reset time and its error text from that model's lock, not from the earliest lock of any model or from the first account's `lastError`.

## Evidence

- `src/sse/services/auth.js:117-135` uses `getEarliestModelLockUntil(c)`, which returns the earliest expiry over every `modelLock_*` field (`open-sse/services/accountFallback.js:152-163`), and takes `lastError` from `lockedConns[0]`.
- `lastError` / `errorCode` are per account and are overwritten by any model's failure (`auth.js:279-287`), so there is no per-model error text today.
- Live symptom: client saw `[403]: HTTP 403 (reset after 2m 14s / 53s / 1m 10s / 58s)` while the requested model's lock was 10 minutes.
- `updateProviderConnection` merges top-level keys shallowly (`src/lib/db/repos/connectionsRepo.js:263-277`), so a flat per-model key needs no read-modify-write and has no cross-model write race.

## Design

- Store the lock's error next to the lock as a flat key `modelLockError_<model>` (or `modelLockError___all` when no model), value `{ message, status }`. The prefix `modelLockError_` does not match the `modelLock_` prefix that the dashboard and `clearAccountError` scan, so no UI code changes.
- Read the requested model's lock expiry as the later of `modelLock_<model>` and `modelLock___all`, whichever are active. This matches what `isModelLockActive` treats as locked.
- Choose the locked connection whose model-scoped expiry is earliest; report that connection's `modelLockError_<model>` entry. If the entry is missing (lock written before this change), report a generic message instead of another model's `lastError`.

## Files to Modify

- `open-sse/services/accountFallback.js`: add `MODEL_LOCK_ERROR_PREFIX`, `getModelLockErrorKey(model)`, `getModelLockUntil(connection, model)`; make `buildModelLockUpdate(model, cooldownMs, error = null)` also write the error key when `error` is given. Keep `getEarliestModelLockUntil` (dashboard and debug log use it).
- `src/sse/services/auth.js`:
  - `markAccountUnavailable`: pass `{ message: reason, status }` into `buildModelLockUpdate`. Keep writing `lastError`/`errorCode` (the dashboard shows them). Note `lockKey = Object.keys(lockUpdate)[0]` at `:290` must still pick the lock key, not the error key — read it via `getModelLockKey` instead.
  - All-locked branch (`:117-135`): compute expiries with `getModelLockUntil(c, model)`; pick the connection with the earliest one; return its `modelLockError_*` message/status as `lastError`/`lastErrorCode`. Keep the Antigravity quota-cache `resetAt` expiries (already model-specific). When the earliest expiry comes from the quota cache rather than a lock, use the quota message the code already logs or the generic text.
  - The debug log at `:110` may keep `getEarliestModelLockUntil` but should print the model-scoped value for consistency.
  - `clearAccountError`: for each cleared `modelLock_<x>` key also null `modelLockError_<x>`; when error state fully resets, null every `modelLockError_*` key.
- `src/lib/db/repos/connectionsRepo.js`: `resetHealthStateOnActivation` also nulls `modelLockError_*` keys.

## Files to Create

- `tests/unit/all-locked-model-scoped.test.js` (mock pattern: `tests/unit/github-monthly-usage-lock.test.js`).

## Tasks & Steps

1. Add the helpers to `accountFallback.js` with JSDoc; export them through the same paths `MODEL_LOCK_PREFIX` uses.
2. Update `markAccountUnavailable` to store the per-model error; fix the `lockKey` log line.
3. Rewrite the all-locked branch to use model-scoped expiry and error.
4. Extend `clearAccountError` and `resetHealthStateOnActivation` cleanup.
5. Write the tests below.

## Tests

- Two accounts; account A has `modelLock_m1` in 10 min and `modelLock_m2` in 30 s with `lastError` from m2; account B has `modelLock_m1` in 12 min. Requesting m1 returns `retryAfter` ≈ A's 10-min lock and the m1 error text, not 30 s and not the m2 text.
- `modelLock___all` later than the model lock wins for that connection.
- Missing `modelLockError_m1` yields the generic message, not `lastError`.
- `markAccountUnavailable(..., model="m1")` writes both `modelLock_m1` and `modelLockError_m1` with `{ message, status }`.
- `clearAccountError(..., "m1")` nulls `modelLockError_m1`; full reset nulls all error keys.
- Existing `fetch-success-clears-account.test.js`, `codebuddy-block-backoff.test.js`, `github-monthly-usage-lock.test.js`, `db-sqlite-vs-lowdb.test.js` still pass (update assertions only where they compare the exact update object, and say why in the test).

## Verification

```bash
cd tests && npx vitest run unit/all-locked-model-scoped.test.js unit/fetch-success-clears-account.test.js unit/codebuddy-block-backoff.test.js unit/github-monthly-usage-lock.test.js unit/db-sqlite-vs-lowdb.test.js
node __baseline__/verify-no-regression.mjs
npx eslint src/sse/services/auth.js open-sse/services/accountFallback.js src/lib/db/repos/connectionsRepo.js   # from repo root
```

## Risks

- Old rows have no error key: handled by the generic fallback text.
- `null`-valued keys accumulate in the JSON `data` column, exactly as `modelLock_*` keys already do. Bounded by the number of models.

## Extension trace

Every provider uses this lock path, so the fix is provider-agnostic by construction. A provider that locks with `model = null` (GitHub monthly lock) keeps working through `modelLock___all` / `modelLockError___all`, covered by the `__all` test.
