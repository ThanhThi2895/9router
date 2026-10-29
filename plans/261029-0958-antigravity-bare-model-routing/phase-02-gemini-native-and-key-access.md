---
phase: 2
title: Gemini-native locate + key access
status: pending
---

# Phase 02: Gemini-native locate and key access

## Context
`src/sse/services/geminiModel.js:63-78`. `locate()` checks only the alias table and then the
slash. For a bare id it returns null today, so `/v1beta` passes the name untouched to
`handleChat`, which then runs `getModelInfo`. Routing already works through phase 01, but the
**effort-variant selection** is skipped. For example, bare `gemini-3.8-flash` with
`thinkingBudget: -1` should become `antigravity/gemini-3.8-flash-high`.

## Steps
1. In `locate()`, after the alias block and before the slash check, handle the case where
   `modelStr` has no `/`:
   - If `getComboByName(modelStr)` is truthy, return null. The combo wins, and the name is left
     for `handleChat`.
   - Call `resolveAntigravityBareModel(modelStr)`. If it matches, return
     `{ provider: match.provider, modelId: match.model }`.
   - Keep everything inside the existing "convenience, never fail" try/catch semantics.
2. The routable-set check covers only the id the client sent. An effort variant chosen
   afterwards comes from `getModelsByProviderId(provider)`, so it is always a real catalog id.
   Leave the existing logic as it is.
3. **Key access: verify only, no code change expected.** `keyAccess.js:97,107,190` resolves
   through `getModelInfo`, so allow and deny follow the new routing automatically. Phase 05 adds
   a test for it. The `/v1beta` route has its own key check at `route.js:265`. Confirm it runs on
   the *resolved* model string.

## Validation
`cd tests && npx vitest run unit/gemini-model-effort.test.js unit/gemini-native-endpoint.test.js`
is green with the toggle off, which is the default.
