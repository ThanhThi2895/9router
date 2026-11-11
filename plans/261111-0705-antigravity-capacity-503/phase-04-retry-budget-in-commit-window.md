---
phase: 4
title: "Retry budget inside the commit window"
status: done
priority: P1
effort: "2h"
dependencies: []
---

# Phase 4: Retry budget inside the commit window

## Goal

For streaming requests wrapped by the SSE keepalive, Antigravity executor retries never sleep past a request-wide deadline that ends before the 10 s commit, so an all-failed request returns a real HTTP 503 with `retry-after` instead of a committed 200 plus an in-stream error.

## Evidence

- Antigravity 503 retries: 3 attempts (`open-sse/providers/registry/antigravity.js:34-36`), delay `1000 * 2^attempt` with attempt 1..3 (`open-sse/executors/antigravity.js:497-502`, called from `open-sse/executors/base.js:117-118`) = 2 + 4 + 8 = 14 s, more than the 10 s commit delay (`runtimeConfig.js:66`). "capacity" is a transient pattern (`antigravity.js:29`).
- Account rotation (`src/sse/handlers/chat.js:405-418`) repeats those retries per account, so only a deadline shared by the whole request bounds the total.
- `withSseKeepalive` wraps the request before the provider is known (`chat.js:49`), so the deadline is computed there and the provider policy is applied later in `handleSingleModelChat`, where `provider` is known.
- Antigravity has one base URL (`registry/antigravity.js:22`), so per-URL retry counters do not multiply further.

## Design

- `open-sse/config/runtimeConfig.js`: add `SSE_RETRY_DEADLINE_MARGIN_MS = 2000` (time reserved for the last upstream round trip plus building the 503), with a comment.
- `src/sse/handlers/chat.js`:
  - `handleChat`: in the keepalive + `stream: true` branch, compute `retryDeadline = Date.now() + SSE_KEEPALIVE_COMMIT_DELAY_MS - SSE_RETRY_DEADLINE_MARGIN_MS` and pass it as `handleChatInner(request, clientRawRequest, { retryDeadline })`. The non-keepalive path passes nothing (behaviour unchanged).
  - Thread `retryDeadline` from `handleChatInner` into every `handleSingleModelChat` call (direct and combo callbacks at `:151`, `:167`, and the combo at `:195`) through one trailing options argument, not more positional parameters.
  - In `handleSingleModelChat`, pass `retryDeadline` to `handleChatCore` only when `provider === "antigravity"` (same style as the existing provider checks in this file); otherwise pass `null`.
- `open-sse/handlers/chatCore.js`: accept `retryDeadline` and forward it to both `executor.execute` calls (`:401`, `:470`).
- `open-sse/executors/base.js`: `execute({ ..., retryDeadline = null })`; in `tryRetry`, after `waitMs` is known, return `false` when `retryDeadline && Date.now() + waitMs >= retryDeadline`, with a debug log `retry skipped: past SSE commit budget`. This covers status retries (`:164`) and network retries (`:188`).
- Check whether any executor overrides `execute` and calls `super.execute`; if so it must forward `retryDeadline` (Antigravity does not override it).

## Files to Modify

- `open-sse/config/runtimeConfig.js`, `src/sse/handlers/chat.js`, `open-sse/handlers/chatCore.js`, `open-sse/executors/base.js`. Read `open-sse/AGENTS.md` before editing under `open-sse/`.

## Files to Create

- `tests/unit/retry-deadline.test.js`.

## Tests

- Base executor with a stub fetch returning 503 three times then 200, `retryDeadline = now + 3000`, fake timers: the 2 s retry runs, the 4 s retry is skipped, and `execute` returns the 503 result in under the deadline.
- Same stub with `retryDeadline = null`: all retries run (current behaviour preserved).
- `handleChat(..., { keepalive: true })` with a `stream: true` body and an Antigravity model whose stubbed upstream always returns capacity 503 on two accounts: the response status is 503 (not 200) with a `retry-after` header. Use the mocking approach in `tests/unit/sse-keepalive-handle-chat.test.js`.
- A non-Antigravity provider in the same setup gets `retryDeadline: null` at `handleChatCore` (spy on the call).
- `antigravity-retry-hook.test.js` still passes.

## Verification

```bash
cd tests && npx vitest run unit/retry-deadline.test.js unit/antigravity-retry-hook.test.js unit/sse-keepalive-handle-chat.test.js unit/sse-keepalive.test.js
node __baseline__/verify-no-regression.mjs
npx eslint src/sse/handlers/chat.js open-sse/handlers/chatCore.js open-sse/executors/base.js open-sse/config/runtimeConfig.js   # from repo root
```

## Risks

- With many accounts, rotation alone (no retries, about 0.5-1 s per upstream 503) can still exceed the window; the client then gets the Phase 3 in-stream error with status and retry time. Rotation is not stopped at the deadline because a later account may succeed.
- Fewer retries per account can turn a recoverable capacity blip into a fallback sooner. Phase 2's 5 s lock plus the combo wait (`combo.js:607`) and the client's own retry on a real 503 cover that.
- `SSE_KEEPALIVE_COMMIT_DELAY_MS` is env-configurable; a value at or below the margin makes the deadline already past, which disables retries for Antigravity streams. Clamp the deadline so retries are only cut, never errored, and note it in the code comment.

## Extension trace

The deadline is generic plumbing (chat → chatCore → BaseExecutor); the policy is the single `provider === "antigravity"` check in `handleSingleModelChat`. A second provider (for example `gemini-cli`, same Google backend) opts in by widening that check; the stable contract is the `retryDeadline` option on `execute`. The provider-gating test proves non-opted providers keep today's retries.
