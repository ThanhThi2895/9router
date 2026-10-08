# Phase 1 — Storage: schema, migration, repo

## Context
Schema lives in `src/lib/db/schema.js` (`TABLES`), migrations in `src/lib/db/migrations/` (registry `index.js`, `001-initial.js` creates all `TABLES` with `IF NOT EXISTS`). Repo pattern to copy: `src/lib/db/repos/requestDetailsRepo.js` (buffer + timer + transaction + cap + shutdown flush). Back up `~/.9router` (or `DATA_DIR`) DB file before running the migration locally.

## Files
- Modify `src/lib/db/schema.js`: add table `unresolvedModels`.
- Create `src/lib/db/migrations/002-unresolved-models.js`: `version: 2`, creates the table and indexes via `buildCreateTableSql` (idempotent).
- Modify `src/lib/db/migrations/index.js`: register `m002`.
- Create `src/lib/db/repos/unresolvedModelsRepo.js`.
- Modify `src/lib/db/index.js` and `src/lib/usageDb.js` (whichever re-exports repo functions today; follow `requestDetailsRepo` exports) to export the new functions.

## Schema
```
unresolvedModels:
  id TEXT PRIMARY KEY            -- sha1/simple hash of `${endpoint}|${requestedModel}|${reason}`
  endpoint TEXT NOT NULL         -- e.g. /v1/chat/completions
  requestedModel TEXT NOT NULL   -- "" for missing_model
  reason TEXT NOT NULL
  provider TEXT
  count INTEGER NOT NULL DEFAULT 0
  firstSeen TEXT NOT NULL
  lastSeen TEXT NOT NULL
  lastError TEXT
  lastUserAgent TEXT
  resolved INTEGER NOT NULL DEFAULT 0
indexes: lastSeen DESC, reason
```
Resolved rows that are hit again flip back to `resolved = 0` (the fix did not work).

## Repo API
- `recordUnresolvedModelEvent({ endpoint, requestedModel, reason, provider, error, userAgent })` — sanitise/truncate, merge into an in-memory `Map` keyed by id (count += 1, keep latest fields), schedule flush (5s). Never throws.
- `flush` — one transaction: `INSERT … ON CONFLICT(id) DO UPDATE SET count = count + excluded.count, lastSeen = excluded.lastSeen, lastError = excluded.lastError, lastUserAgent = excluded.lastUserAgent, provider = COALESCE(excluded.provider, provider), resolved = 0`; then evict beyond 500 by oldest `lastSeen`.
- `getUnresolvedModels({ reason, includeResolved, page, pageSize })`.
- `setUnresolvedModelResolved(id, resolved)`, `deleteUnresolvedModel(id)`, `clearUnresolvedModels()`.
- Register flush on `beforeExit`/`SIGINT`/`SIGTERM` like `requestDetailsRepo`.

Confirm the `sql.js` and `node:sqlite` adapters both accept `ON CONFLICT … DO UPDATE` with `count + excluded.count` (requestDetails already uses upsert, so syntax support is expected).

## Validation
- Fresh DB: tables created; existing DB at version 1: migration 2 runs once.
- Unit test in phase 4.

## Risk / rollback
Additive table only. Rollback = revert files; the orphan table is harmless.
