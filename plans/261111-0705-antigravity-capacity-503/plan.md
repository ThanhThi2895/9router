---
title: "Antigravity 503 capacity handling"
description: "Make Antigravity capacity 503s short-lived, model-scoped, and reported to clients with a real status and retry time."
status: done
priority: P1
effort: 6h
branch: master
tags: [bugfix, backend, api]
blockedBy: []
blocks: []
created: 2026-11-11
---

# Antigravity 503 capacity handling

## Overview

Google's Antigravity backend answers `503 MODEL_CAPACITY_EXHAUSTED` ("No capacity available for model ...") when a model is briefly overloaded. Today that error raises the account-wide backoff level, the all-locked 503 reports the wrong model's reset time and error text, the executor's retries push the response past the 10 s SSE commit window, and the in-stream error that follows carries no numeric status or retry time. This plan fixes the four items the user approved. Source of truth for the evidence: the verified findings file (`capacity-503-findings.md`, code at `3ba13023`).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | The all-locked 503 reports the requested model's lock time and that lock's error text | P1 |
| 2 | An Antigravity capacity error applies a short fixed model lock and never raises the account backoff level | P1 |
| 3 | The in-stream SSE error carries numeric status, retry seconds, and `overloaded_error` for Claude-format clients | P2 |
| 4 | Antigravity executor retries stay inside the SSE commit window so a real HTTP 503 can be sent | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Model-scoped all-locked error](./phase-01-model-scoped-all-locked-error.md) | Pending |
| 2 | [Capacity error without backoff](./phase-02-capacity-error-no-backoff.md) | Pending |
| 3 | [Status fields on in-stream errors](./phase-03-stream-error-status-fields.md) | Pending |
| 4 | [Retry budget inside the commit window](./phase-04-retry-budget-in-commit-window.md) | Pending |

Phases own disjoint files except `open-sse/config/runtimeConfig.js`, where Phase 3 adds one `HTTP_STATUS` entry and Phase 4 adds one constant. They can land in any order. Run them in the listed order so each regression gate starts from a known state.

## Out of scope (deferred by the user)

- Honouring Google `RetryInfo` on 503 (unverified that Google sends it).
- Adding a `gemini-3.8-flash-medium` fallback to the live combo (config, not code).
- Re-authorizing accounts on the live server.

## Success Criteria

- [ ] All four phases' new tests pass.
- [ ] `node tests/__baseline__/verify-no-regression.mjs` (run from `tests/`) reports no new failures. The 18 stale token-refresh tests that mock `global.fetch` are pre-existing and unrelated.
- [ ] `npx eslint` is clean on every touched file.
- [ ] `CHANGELOG.md` has one `fix(antigravity)` entry describing the user-visible behaviour change.

## Security notes

No credential, auth, or `X-Forwarded-For` code is touched. The new per-model error field stores the same truncated (200 chars) upstream error text already stored in `lastError`, and in-stream errors expose only text that the JSON 503 already exposes.

<!-- slug: antigravity-capacity-503 -->
