---
title: "Persist requests that target a missing or unroutable model"
description: "Record every request whose model cannot be resolved or served in a durable, aggregated store and show it in the dashboard so it can be fixed later."
status: complete
priority: P2
effort: 6h
branch: thinguyen/feat/missing-model-log
tags: [gateway, observability, dashboard, db]
blockedBy: []
blocks: []
created: 2026-10-08
---

# Missing-model request log

## Outcome
When a client calls `/v1/*` with a model the gateway cannot serve, the event is saved to SQLite with the requested model, the reason, the endpoint and a hit count. The dashboard lists these events so the owner can add an alias, combo, provider connection or custom model, then mark the entry resolved.

## Current state (verified)
- `src/sse/handlers/{chat,embeddings,tts,stt,imageGeneration,systemone}.js` only call `log.warn` for `Missing model`, `Invalid model format` and `No active credentials for provider`. Nothing is persisted.
- `appendRequestLog()` in `src/lib/db/repos/usageRepo.js:779` is a **no-op**, so it cannot be reused.
- `saveRequestDetail()` (`src/lib/db/repos/requestDetailsRepo.js:143`) is gated by the observability toggle and keeps only the newest 200 rows (`DEFAULT_MAX_RECORDS`). Normal traffic would evict missing-model events within minutes, so it is the wrong store for "check later".
- An unknown bare model (no `/`) is never "invalid": `getModelInfoCore` infers a provider (fallback `openai`). An unknown prefix such as `foo/bar` becomes provider `foo` and fails with "No active credentials". A known provider with a wrong model id passes routing and fails upstream with 404/400. The plan must therefore also capture **upstream model-not-found** errors, which is the most common real case.

## Reasons recorded
| reason | where detected |
|---|---|
| `missing_model` | body has no `model` |
| `invalid_model_format` | `getModelInfo` returns no provider and the name is not a combo |
| `no_credentials` | `getProviderCredentials` returns nothing on the first try (`excludeConnectionIds.size === 0`) |
| `upstream_model_not_found` | core returns `status` 404, or 400/422 whose error text matches a model-not-found pattern |

Rate-limit, all-accounts-exhausted and auth (`requireApiKey`) failures are **not** missing-model events and stay out of scope.

## Design
- New table `unresolvedModels`, one row per `(endpoint, requestedModel, reason)` key, with `provider`, `count`, `firstSeen`, `lastSeen`, `lastError`, `lastUserAgent`, `resolved`. Aggregation keeps it small and directly answers "what is broken and how often".
- New repo `src/lib/db/repos/unresolvedModelsRepo.js` with an in-memory buffer flushed every 5s (same pattern as `requestDetailsRepo`), a hard cap of 500 rows (oldest `lastSeen` evicted), and input sanitising.
- One helper `recordUnresolvedModel(ctx)` in `src/sse/services/unresolvedModel.js` that all six handlers call. It never throws and never awaits the DB write (fail-open, like RTK hooks).
- `open-sse/` is not modified; upstream classification happens in the `src/sse/handlers` loop using `result.status` / `result.error`.
- Always on (not tied to the observability toggle), because it stores no prompt content and is bounded.

## Phases
| # | Phase | Status | Depends on |
|---|---|---|---|
| 1 | [Storage: schema, migration, repo](phase-01-storage.md) | complete | — |
| 2 | [Record from request handlers](phase-02-record-in-handlers.md) | complete | 1 |
| 3 | [API route and dashboard tab](phase-03-api-and-dashboard.md) | complete | 1 |
| 4 | [Tests and regression check](phase-04-tests.md) | complete | 2, 3 |

## Acceptance criteria
1. `POST /v1/chat/completions` with `model: "nope/does-not-exist"` returns the same error as today and creates one `unresolvedModels` row with reason `no_credentials`; repeating it increments `count` instead of adding rows.
2. Missing `model`, an unknown combo-like name and an upstream 404 each produce a row with the right reason, for chat and for each of embeddings, tts, stt, image generation and systemone.
3. HTTP responses, status codes and latency of the failing request are unchanged (write is buffered, not awaited).
4. A DB failure inside the recorder never breaks the request.
5. No API key, Authorization header, cookie or prompt/body content is stored. `requestedModel` is truncated to 200 chars, user agent to 200 chars, error text to 500 chars.
6. Dashboard Usage page has a "Missing models" tab listing entries (model, reason, endpoint, count, first/last seen) with "Mark resolved", "Delete" and "Clear all". `/api/usage/missing-models` is behind the existing dashboard guard (not in `PUBLIC_API_PATHS`).
7. Table never exceeds 500 rows.
8. `node tests/__baseline__/verify-no-regression.mjs` shows no new failures.

## Non-goals
- Auto-creating aliases or models from logged entries.
- Notifications/alerts.
- Changing `open-sse/` core error handling or the observability `requestDetails` store.
- Reviving the no-op `appendRequestLog`.

## Security notes
- `requestedModel` and user agent are client-controlled: stored as text, truncated, rendered as plain text in React (no `dangerouslySetInnerHTML`).
- Write amplification from a client spraying random model names is bounded by the 500-row cap and the 5s buffered flush; distinct keys beyond the cap evict the oldest.
- The read/delete API is dashboard-authenticated; do not add it to public paths.

## Unresolved questions
- Should `no_credentials` for a **known** provider that is simply not connected be shown with lower priority than truly unknown models? The plan records both under the same reason with `provider` set; the UI can filter by reason.
