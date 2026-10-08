---
title: Combo picker hid custom model shadowed by image built-in
date: 2026-10-08
summary: Custom LLM gemini-3.1-flash-image on antigravity missing from combo picker; dedupe now ignores non-visible built-ins
---

# Combo picker hid custom model shadowed by image built-in

## What happened
A custom LLM model `gemini-3.1-flash-image` added on antigravity did not appear in the combo "Add Model" picker. Antigravity ships a built-in model with the same id but `kind: "image"`. In `src/shared/components/ModelSelectModal.js`, the standard-provider branch removed custom models whose id matched any built-in id. The LLM kind filter then removed the image built-in, so neither entry was left.

## Decision
Custom models are deduplicated only against built-ins that survive `filterByKind` for the current picker (`visibleHardcoded`). This matches the earlier provider-page fix, which deduplicates against the LLM chips it renders. `hasHardcoded` still uses the full built-in list, so alias-pattern behavior is unchanged.

## Verification
The regression test `tests/unit/model-select-custom-shadowed-by-typed-builtin.test.js` fails on the old source and passes with the fix. The existing `kenari-deepseek-vision-zed-modal` test still passes. ESLint was not run because root dependencies are not installed.

## Next steps
Check the combo picker in the running dashboard.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
