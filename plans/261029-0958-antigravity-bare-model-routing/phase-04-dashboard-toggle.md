---
phase: 4
title: Dashboard toggle
status: pending
---

# Phase 04: Dashboard toggle

## Context
`src/app/(dashboard)/dashboard/profile/page.js`, the "Routing Strategy" card at around line
1439. It has existing `Toggle` rows for Round Robin and Combo Round Robin, and each one saves
with `fetch("/api/settings", { method: "PATCH", body: { key } })`.

## Steps
1. Add a toggle row to the Routing Strategy card, labelled "Route bare model names to Antigravity".
   Use this help text: "When on, a model id sent without a provider prefix (e.g. `claude-opus-5-5`)
   goes to Antigravity if it is in your Antigravity catalog. Combos and aliases still win. API
   keys scoped to other providers lose access to those ids. Antigravity is marked deprecated."
2. Copy the handler pattern of the neighbouring toggles: optimistic `setSettings`, PATCH
   `{ antigravityBareModelRouting: bool }`, and revert on failure.
3. No API change is needed. The key is not in `PROTECTED_SETTING_KEYS` and needs no special
   handling.

## Validation
Lint the file with `npx eslint "src/app/(dashboard)/dashboard/profile/page.js"`, then run a
manual check: toggle the setting, reload, and confirm it persisted.
