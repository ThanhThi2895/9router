---
phase: 3
title: /v1/models listing
status: done
---

# Phase 03: /v1/models listing

## Context
`src/app/api/v1/models/route.js`, `buildModelsList` (lines 321-643). Combos are pushed first,
then per-provider entries, then the `seenModelIds` dedupe runs at the end.

## Steps
1. Before the dedupe loop, add this only when `kindFilter` includes the LLM kind or the image kind:
   - `const bareIds = await getAntigravityBareModelIds()`, wrapped in try/catch. If it returns
     null, skip this step.
   - For each id, match it against `kindFilter` with the same `modelKind` lookup that the
     provider loop uses for Antigravity static models. Custom ids default to LLM.
   - Push `{ id, object: "model", owned_by: "antigravity", capabilities: getCapabilitiesForModel("antigravity", id) }`.
     Copy `context_length` and `max_completion_tokens` from the capabilities when they are finite,
     the same way the provider entries do.
2. Because the entries come after the combos, the existing dedupe lets a same-named combo
   shadow the bare entry. Leave the ordering comment where it is.
3. `/v1/models/[...model]` reuses `buildModelsList`, so it picks this up automatically.
4. `filterModelsListForKey` resolves each id through `getModelInfo`, so keys without
   Antigravity access do not see the bare entries.

## Validation
`cd tests && npx vitest run unit/models-route-shadow-dedupe.test.js unit/v1-models-combo-context.test.js`
is green.
