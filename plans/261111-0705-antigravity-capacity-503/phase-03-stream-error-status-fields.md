---
phase: 3
title: "Status fields on in-stream errors"
status: done
priority: P2
effort: "1h"
dependencies: []
---

# Phase 3: Status fields on in-stream errors

## Goal

When the SSE response was already committed as 200 and the real result is an error, the in-stream error event carries the numeric status and the retry time, and Claude-format clients get `type: "overloaded_error"` for a 503. Existing fields keep their values; `code` stays a string.

## Evidence

- Commit after 10 s: `open-sse/config/runtimeConfig.js:66`; wrapper `src/sse/handlers/chat.js:43-49`; committed as 200 at `open-sse/utils/sseKeepalive.js:41`.
- Late JSON error becomes an in-stream event at `sseKeepalive.js:104-113` via `buildStreamErrorBytes` (`open-sse/utils/streamHelpers.js:186-194`), which uses `buildErrorBody` → `type: "server_error"`, `code: "service_unavailable"` (`open-sse/utils/error.js:9-21`, `errorConfig.js:12`).
- Only `error.message` is read from the late body (`sseKeepalive.js:110`); the `retry-after` header set by `unavailableResponse` (`error.js:128`) is dropped.

## Design

- `buildStreamErrorBytes(statusCode, message, clientFormat, { retryAfterSec } = {})`:
  - error object = `buildErrorBody(...)`'s error plus `status: statusCode` (number) and, when given, `retry_after: retryAfterSec` (integer seconds, same unit as the HTTP header).
  - For `FORMATS.CLAUDE` and status 503 or 529, set `error.type = "overloaded_error"` (Anthropic's overload type). Other formats keep `type`.
  - `code` is never changed.
- `commitSse` non-SSE branch: read `response.headers.get("retry-after")`; if it parses as a positive integer, pass it as `retryAfterSec`. Ignore HTTP-date values (9Router only emits seconds).
- Other callers (`sseKeepalive.js:98,124`, `streamingHandler.js:96`) gain `status` automatically and no `retry_after`.
- Field names `status` and `retry_after` are a decision made in this plan; they mirror the HTTP status and the `retry-after` header.

## Files to Modify

- `open-sse/utils/streamHelpers.js`: `buildStreamErrorBytes` as above. Use `FORMATS` and `HTTP_STATUS` constants, no bare literals for status codes (see `open-sse/AGENTS.md`). `HTTP_STATUS` has `SERVICE_UNAVAILABLE` but no 529; add `OVERLOADED: 529` to `HTTP_STATUS` in `open-sse/config/runtimeConfig.js` (this phase then also owns that one line).
- `open-sse/utils/sseKeepalive.js`: pass `retryAfterSec` in the non-SSE branch.

## Tests (extend `tests/unit/sse-keepalive.test.js`)

- Late 503 JSON with `retry-after: 42`, Claude format: `event: error` frame whose `error` has `type: "overloaded_error"`, `status: 503`, `retry_after: 42`, original `message`, `code: "service_unavailable"`.
- Same with OpenAI format: `type: "server_error"`, `code: "service_unavailable"` (string), `status: 503`, `retry_after: 42`, then `data: [DONE]`.
- Late 502 without header: `status: 502`, no `retry_after`, Claude type unchanged.
- Existing assertions in `sse-keepalive.test.js` and `sse-keepalive-handle-chat.test.js` that compare whole error objects are updated for the new fields only.

## Verification

```bash
cd tests && npx vitest run unit/sse-keepalive.test.js unit/sse-keepalive-handle-chat.test.js
node __baseline__/verify-no-regression.mjs
npx eslint open-sse/utils/streamHelpers.js open-sse/utils/sseKeepalive.js   # from repo root
```

## Risks

- Not verified whether Claude Code retries an in-stream `overloaded_error`; the change is additive, so the worst case is today's behaviour. Record the observed client behaviour in the cook report if a live check is possible.
- A strict OpenAI client that rejects unknown error fields: none known; the OpenAI SDKs read `message`/`type`/`code` and ignore extras.

## Extension trace

The new fields are format-agnostic except the Claude `type` override. An OpenAI Responses-format client goes through the non-Claude branch; confirm in a test that `formatSSE` for `FORMATS.OPENAI_RESPONSES` still emits a parseable `data:` error frame with the new fields.
