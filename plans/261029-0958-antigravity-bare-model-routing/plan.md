---
title: Antigravity bare-model routing
status: proposed
created: 2026-10-29
branch: master
mode: auto (standard)
---

# Antigravity bare-model routing

## Outcome
With a dashboard toggle on, a request for a bare model id (no `provider/` prefix), such as
`gemini-3.8-flash` or `claude-opus-5-5`, routes to `antigravity` when that id is routable on
Antigravity. No combo or alias has to be created for each new model.

## Precedence (unchanged except for the new step 3)
1. Combo name. `src/sse/services/model.js` already checks combos before the core resolver.
2. User model alias, then `BUILTIN_MODEL_ALIASES`. Both are in `getModelInfoCore`.
3. **New:** the Antigravity bare-model rule. It runs only when the setting is on, at least one
   Antigravity connection is active, and the id is in the routable set.
4. The existing prefix inference, `inferProviderFromModelName`.

## Constraints
- The setting is off by default (`antigravityBareModelRouting: false`), so behaviour with the
  toggle off is byte-identical to today.
- `open-sse/` stays provider-agnostic. The engine gets a generic optional hook, and every
  Antigravity- and DB-specific piece lives app-side in `src/sse/services/`.
- No hardcoded alias strings. Use the registry (`antigravity` id and alias) and `providerModels.js` helpers.
- The rule fails open. Any error inside it returns null, and resolution falls through to step 4.

## Non-goals
- Live discovery of Antigravity models. No live resolver exists for Antigravity. A new upstream
  model becomes routable through a registry update or a custom model on the Antigravity
  provider page. The custom-model path is the "no per-model alias" answer.
- Fuzzy or prefix matching. Ids must match exactly. `gemini-3-pro`, the example in the request,
  is **not** in the current Antigravity catalog, so it would still go to `gemini` unless the
  user adds it as a custom model.
- Generalising the rule to other providers.

## Phases
| # | Phase | Depends on | Files |
|---|---|---|---|
| 01 | [Resolver hook + setting](phase-01-resolver-and-setting.md) | none | `open-sse/services/model.js`, `src/sse/services/model.js`, new `src/sse/services/antigravityBareModel.js`, `src/lib/db/repos/settingsRepo.js` |
| 02 | [Gemini-native locate + key access](phase-02-gemini-native-and-key-access.md) | 01 | `src/sse/services/geminiModel.js` |
| 03 | [/v1/models listing](phase-03-models-list.md) | 01 | `src/app/api/v1/models/route.js` |
| 04 | [Dashboard toggle](phase-04-dashboard-toggle.md) | 01 | `src/app/(dashboard)/dashboard/profile/page.js` |
| 05 | [Tests + regression check](phase-05-tests.md) | 01–04 | new `tests/unit/antigravity-bare-model-routing.test.js`, `CHANGELOG.md` |

Phases 02, 03 and 04 touch disjoint files and can run in parallel after 01.

## Entrypoint coverage
All of these go through `getModelInfo` in `src/sse/services/model.js`, so phase 01 covers them:
`/v1/chat/completions`, `/v1/responses` (and `/compact`), and `/v1/messages`, all via `handleChat`;
the image, video, tts, stt, embeddings and systemone handlers; key-access checks in
`keyAccess.js`; and `/api/translator/translate`. The only entrypoint that bypasses
`getModelInfo` is `/v1beta`'s `resolveGeminiModel → locate`, and phase 02 handles it.

## Decision: /v1/models lists bare ids when the toggle is on
Yes, list them. Clients like the Gemini CLI, Codex and IDE pickers choose from `/v1/models`, so
a bare id they cannot see has to be typed by hand. Bare entries are appended **after** the
combo and provider entries. The existing `seenModelIds` dedupe then lets a combo with the same
name win, which matches the routing precedence. Entries are emitted only for the routable set
from phase 01, so the list never advertises an id that would route elsewhere. If the toggle is
off, nothing changes.

## Acceptance criteria
- With the toggle off, every existing test result is unchanged (checked with `verify-no-regression.mjs`).
- With the toggle on and an active Antigravity connection, `getModelInfo("claude-opus-5-5")`
  returns `{ provider: "antigravity", model: "claude-opus-5-5" }`.
- With the toggle on but no active Antigravity connection, the id falls through to prefix inference.
- A combo or alias with the same name still wins over the new rule.
- An id not in the routable set (for example `gemini-3-pro`) still goes to inference.
- A disabled Antigravity model is not routed by the rule.
- `/v1beta/models/gemini-3.8-flash:streamGenerateContent` with a thinking budget resolves to an
  `antigravity/gemini-3.8-flash-<effort>` variant when the toggle is on.
- `/v1/models` contains the bare ids, deduped, only when the toggle is on.
- The key-access decision uses the same resolution as routing (covered by a test).

## Security notes
- Key access stays consistent because `enforceKeyAccess` and `filterModelsListForKey` resolve
  through the same `getModelInfo`. Turning the toggle on **changes which provider a bare id
  resolves to**. A key scoped to `gemini/*` that used to call bare `gemini-3.8-flash` is denied
  once the id resolves to Antigravity. That is correct, because the request would now spend
  Antigravity credentials. Mention this in the setting's help text.
- The setting goes through the authenticated `PATCH /api/settings` and is not a secret, so it
  does not belong on the protected-keys list. The change adds no new outbound URL and no
  header handling, so there is no SSRF or `X-Forwarded-For` surface.
- Antigravity is marked `deprecated` with a risk notice, and the help text should say so.

## Risks
- Extra DB reads per bare-id request: settings, connections, custom models and disabled models.
  The settings read comes first and short-circuits when the toggle is off. All of these are
  local SQLite reads and are not cached, which avoids stale invalidation.
- Gemini-native `locate` currently ignores combos. Phase 02 must check combos before applying
  the new rule, or a combo named like an Antigravity id would be bypassed.

## Rollback
Turn the toggle off. That restores today's behaviour without a deploy. A code revert is
self-contained to the files listed above, and there is no migration.
