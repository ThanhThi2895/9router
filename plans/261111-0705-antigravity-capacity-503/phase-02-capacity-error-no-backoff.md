---
phase: 2
title: "Capacity error without backoff"
status: done
priority: P1
effort: "1h"
dependencies: []
---

# Phase 2: Capacity error without backoff

## Goal

An Antigravity capacity error (`MODEL_CAPACITY_EXHAUSTED` / "No capacity available for model ...") applies a short fixed model lock (5 s) and leaves the account backoff level unchanged. Other providers keep the generic `capacity` backoff rule.

## Evidence

- Generic rule `{ text: "capacity", backoff: true }` at `open-sse/config/errorConfig.js:73` raises the per-account level; formula `accountFallback.js:9-13` (2 s × 2^(level-1), max 5 min, max level 15).
- The level is per account and shared by all models (`auth.js:251,283`); it resets only when no other model lock on the account is active (`auth.js:324-341`). Live: one account at level 15 despite 434 successes on the model.
- `ERROR_RULES` already support a `provider` field (`errorConfig.js:61-63`; matched in `checkFallbackError`, `accountFallback.js:35`).
- A fixed-cooldown rule returns no `newBackoffLevel`, and `markAccountUnavailable` writes `newBackoffLevel ?? backoffLevel` (`auth.js:284`), so the level is kept, not raised.
- `COOLDOWN.short` is 5 000 ms; the combo transient wait at `open-sse/services/combo.js:607` fires for `cooldownMs <= 5000` with status 503.

## Files to Modify

- `open-sse/config/errorConfig.js`: insert, above the generic `capacity` rule, two Antigravity-scoped rules with `cooldownMs: COOLDOWN.short`:
  - `{ provider: "antigravity", text: "model_capacity_exhausted", cooldownMs: COOLDOWN.short }`
  - `{ provider: "antigravity", text: "no capacity available", cooldownMs: COOLDOWN.short }`
  Add a one-line comment: Google capacity exhaustion is a short, model-wide condition, not an account fault, so it must not escalate the account's backoff.

## Files to Create

- `tests/unit/antigravity-capacity-cooldown.test.js`.

## Tasks & Steps

1. Confirm the provider id that reaches `checkFallbackError` from both callers is the canonical `"antigravity"`: `markAccountUnavailable` passes `resolveProviderId(provider)`; check what `combo.js:582` passes as `provider` (alias or id). If combo passes an alias, resolve it there too and add that to this phase's file list.
2. Confirm the error text that reaches `markAccountUnavailable` (`result.error` from `chatCore`) still contains one of the two phrases (read how chatCore builds `error` for a non-2xx upstream). Text matching is lower-cased.
3. Add the two rules.
4. Write the tests.

## Tests

- `checkFallbackError(503, '{"error":{"status":"UNAVAILABLE","message":"No capacity available for model gemini-x","details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}', 7, "antigravity")` returns `{ shouldFallback: true, cooldownMs: 5000 }` with no `newBackoffLevel`.
- Same text with provider `"codex"` (or null) still returns a backoff result with `newBackoffLevel: 8`.
- `markAccountUnavailable` on an Antigravity connection at `backoffLevel: 7` writes `backoffLevel: 7` and a `modelLock_<model>` about 5 s ahead.
- Existing `codex-fast-capacity.test.js` and `account-fallback-4xx.test.js` still pass.

## Verification

```bash
cd tests && npx vitest run unit/antigravity-capacity-cooldown.test.js unit/codex-fast-capacity.test.js unit/account-fallback-4xx.test.js
node __baseline__/verify-no-regression.mjs
npx eslint open-sse/config/errorConfig.js   # from repo root
```

## Risks

- An account whose level is already high keeps that level until a clean success clears it; this phase only stops further growth. Lowering existing levels is outside the approved scope.
- If Google rewords the message, the generic `capacity` rule takes over again (backoff). The two phrases cover the reason code and the human text.

## Extension trace

`gemini-cli` talks to the same Google Code Assist backend and may return the same 503. Adding it is one more provider-scoped rule pair; the contract (`ERROR_RULES` entry with `provider`) stays the same. Not added here because no evidence shows it receives this error.
