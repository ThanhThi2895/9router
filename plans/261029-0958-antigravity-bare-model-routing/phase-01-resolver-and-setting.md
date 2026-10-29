---
phase: 1
title: Resolver hook + setting
status: completed
---

# Phase 01: Resolver hook and setting

## Context
- `open-sse/services/model.js:94-123`: `getModelInfoCore` resolves the user alias, then the
  builtin alias, then `inferProviderFromModelName`.
- `src/sse/services/model.js:38-79`: `getModelInfo` handles provider-node prefixes and the
  combo check, then calls the core.
- `src/lib/db/repos/settingsRepo.js:7`: `DEFAULT_SETTINGS`. `mergeWithDefaults` back-fills
  missing keys.

## Steps
1. **Engine hook (generic).** Give `getModelInfoCore(modelStr, aliasesOrGetter, options = {})`
   an optional `options.resolveBareModel`, an async function `(modelId) => {provider, model} | null`.
   Call it after both alias lookups and before inference. Wrap the call in try/catch and fall
   through on error. Existing two-argument callers are unaffected. Keep the hook name generic,
   with no "antigravity" in `open-sse/`.
2. **Setting.** Add `antigravityBareModelRouting: false` to `DEFAULT_SETTINGS`.
3. **App-side resolver**, in the new file `src/sse/services/antigravityBareModel.js`:
   - `export async function getAntigravityBareModelIds()` returns a `Set<string>`, or null when
     the rule is inactive.
     - If `getSettings().antigravityBareModelRouting !== true`, return null. Do this first so the
       off path costs only the settings read.
     - Load active connections with `getProviderConnections({ provider: "antigravity" })`, keeping
       those with `isActive !== false`. If there are none, return null.
     - For each active connection, use `providerSpecificData.enabledModels` if it is a non-empty
       array, otherwise the static ids from `getModelsByProviderId("antigravity")`. Union the results.
     - Add custom models whose `providerAlias` is the Antigravity id or one of its registry
       aliases, read from the registry entry rather than hardcoded `"ag"`. Use `type` llm or
       image only.
     - Remove ids listed in `getDisabledModels()` under the Antigravity alias or id.
   - `export async function resolveAntigravityBareModel(modelId)` returns
     `{ provider: "antigravity", model: modelId }` when the id is in the set, otherwise null.
     Wrap the body in try/catch and return null on any error.
   - Take the provider id from the registry entry, not a string literal, wherever practical.
4. **Wire it in.** In `src/sse/services/model.js`, call
   `getModelInfoCore(modelStr, getModelAliases, { resolveBareModel: resolveAntigravityBareModel })`.
   The combo check above it stays first.

## Validation
- `cd tests && npx vitest run unit/model-routing.test.js unit/v1-model-lookup-3588.test.js`
  is green.
- Phase 05 tests cover the behaviour.

## Risk
The hook signature change is additive. `open-sse/index.js` re-exports `getModelInfoCore`, and
external callers that pass two arguments keep today's behaviour.
