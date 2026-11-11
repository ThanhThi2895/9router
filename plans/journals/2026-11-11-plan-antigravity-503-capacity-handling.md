---
title: "Plan: Antigravity 503 capacity handling"
date: 2026-11-11
summary: "Planned four fixes for Antigravity capacity 503s: model-scoped all-locked error, no-backoff capacity lock, status fields on in-stream errors, retry budget inside the SSE commit window."
---

# Plan: Antigravity 503 capacity handling

## What happened
Planned the four user-approved fixes from the verified capacity-503 findings (code at 3ba13023). Plan: `plans/261111-0705-antigravity-capacity-503/`.

## Decisions
- Per-model lock error stored as a flat `modelLockError_<model>` key; the shallow merge in `updateProviderConnection` avoids cross-model write races, and the prefix does not collide with `modelLock_` scanners.
- Capacity errors get Antigravity-scoped `ERROR_RULES` entries with the 5 s short cooldown. The rules return no `newBackoffLevel`, so the account level is kept.
- In-stream errors gain numeric `status` and `retry_after` fields, and Claude-format clients get `overloaded_error` for 503/529. `code` stays unchanged.
- A request-wide `retryDeadline` (commit delay minus 2 s) is threaded chat → chatCore → BaseExecutor.tryRetry and applied only for `provider === "antigravity"`.

## Next steps
Run `/ak-cook plans/261111-0705-antigravity-capacity-503/plan.md`. Still unverified: whether Claude Code retries an in-stream `overloaded_error`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
