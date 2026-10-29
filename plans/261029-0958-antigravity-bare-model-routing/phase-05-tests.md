---
phase: 5
title: Tests + regression check
status: pending
---

# Phase 05: Tests and regression check

## New file: `tests/unit/antigravity-bare-model-routing.test.js`
Follow the temp `DATA_DIR` + `vi.resetModules()` pattern from `tests/unit/model-routing.test.js`.
Seed settings, connections, combos, aliases, custom models and disabled models through the real
repos.

| Case | Expect |
|---|---|
| Toggle off, active AG connection, `claude-opus-5-5` | `anthropic` (unchanged) |
| Toggle on, no AG connection | prefix inference (`anthropic`) |
| Toggle on, inactive AG connection only | prefix inference |
| Toggle on, active AG connection, `claude-opus-5-5` | `antigravity` |
| Toggle on, `gemini-3-pro` (not in catalog) | `gemini` |
| Toggle on, combo named `gemini-3.8-flash` | `provider: null` (combo path) |
| Toggle on, alias `claude-opus-5-5` → `anthropic/...` | `anthropic` |
| Toggle on, connection `enabledModels: ["gemini-3.8-flash"]` | `claude-opus-5-5` falls through, `gemini-3.8-flash` → AG |
| Toggle on, AG custom model `gemini-9-new` | `antigravity` |
| Toggle on, `claude-opus-5-5` disabled under AG | falls through |
| Toggle on, `ag/claude-opus-5-5` | `antigravity` (prefix path untouched) |
| `resolveGeminiModel("gemini-3.8-flash", {thinkingBudget:-1})`, toggle on | `antigravity/gemini-3.8-flash-high` |
| Same with a combo of that name | returned untouched |
| `buildModelsList([llm])`, toggle on | contains bare `claude-opus-5-5`, `owned_by: "antigravity"`, no duplicates |
| `buildModelsList`, toggle off | no bare AG entries |
| Key access: key allowed `ag/*`, bare id, toggle on | allowed; key allowed `anthropic/*` | denied |

## Regression
```bash
cd tests && npx vitest run unit/antigravity-bare-model-routing.test.js
cd tests && npx vitest run   # full run, then:
node tests/__baseline__/verify-no-regression.mjs
npx eslint open-sse/services/model.js src/sse/services src/app/api/v1/models/route.js
```
The pass criterion is no new failures beyond the baseline known-fails.

## Docs
Add a `CHANGELOG.md` entry under the next unreleased version. `docs/ARCHITECTURE.md` has no
section on model-name resolution, so it gets no change.
