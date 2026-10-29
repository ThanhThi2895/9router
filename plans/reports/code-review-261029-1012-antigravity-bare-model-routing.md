# Code review: Antigravity bare-model routing (uncommitted changes)

Scope: the uncommitted diff for `plans/261029-0958-antigravity-bare-model-routing`. That covers
`open-sse/services/model.js`, `src/sse/services/{model,geminiModel,antigravityBareModel}.js`,
`src/app/api/v1/models/route.js`, `src/lib/db/repos/settingsRepo.js`, the profile page, the new
test, and `CHANGELOG.md`. The untracked `AGENTS.md` was ignored as requested.

Verdict: no blocking security issue was found. There are two low-severity findings and a few notes.

## Security

- **Key-access consistency holds in the normal path.** `enforceKeyAccess`, `getAllowSets`,
  `filterModelsListForKey` and routing (`chat.js:196`) all resolve through `getModelInfo`, so the
  allow-list side and the request side move together when the toggle flips. `/v1beta`
  key-checks the rewritten `antigravity/<id>-<effort>` string inside `handleChat`, which is the
  resolved target. Combos still win: `getModelInfo` checks `getComboByName` first, and
  `locate()` returns null for a combo name.
- **Settings PATCH exposure: no new exposure.** `/api/settings` is not in the public list or
  public prefixes of `src/dashboardGuard.js`, so it requires dashboard auth. The value is read
  with a strict `=== true` (`antigravityBareModel.js:15`), so a non-boolean sent through the
  existing mass-assignment PATCH counts as off. The setting is not a secret, so it correctly
  stays off `PROTECTED_SETTING_KEYS`. The diff adds no outbound URL, header handling or IP logic.

## Findings

1. **Low (security, PLAUSIBLE): a fail-open resolver can make the key check and routing disagree.**
   `resolveAntigravityBareModel` swallows errors (`antigravityBareModel.js:45-50`), and
   `chat.js` resolves the model twice: once in `enforceKeyAccess` (line 101) and again for
   routing (line 196). Here is the failure scenario. A restricted key lists bare
   `claude-opus-5-5` (or `anthropic/claude-opus-5-5`). During the check, a transient SQLite error
   or a toggle flip makes the resolver fall through to inference (`anthropic`), so the request is
   allowed. Routing then resolves to `antigravity` and spends Antigravity credentials that the
   key was never checked against. The window needs a transient DB error or a concurrent
   settings change, so the likelihood is low. Possible fixes: resolve once in `handleChat` and
   pass the result to both the check and routing, or fail closed (deny) in key-access when the
   bare resolver errors.
2. **Low (correctness): `/v1/models` can advertise a bare id under the wrong owner.**
   `route.js:636-656` appends `{ id, owned_by: "antigravity" }` for every routable id. A
   **user model alias** with the same name (for example `claude-opus-5-5 → cc/claude-opus-5-5`)
   wins in routing, but alias keys are never listed, so dedupe does not catch the clash. The
   entry then claims Antigravity ownership and capabilities for an id that routes to `cc`. This
   contradicts the plan's statement that the list "never advertises an id that would route
   elsewhere". Key filtering is still correct because it re-resolves through `getModelInfo`.
   Fix: skip ids that are keys in `modelAliases`, which is already loaded at line 351.

## Notes (no change required)

- In `route.js:641-643`, `kindById` is filled from custom models of **every** provider, not
  only the Antigravity aliases. A same-id custom model on another provider can set the kind.
  The impact is tiny. Filtering by `AG_ALIASES`-style aliases would make the intent exact.
- On `/v1beta` with the toggle on, a restricted key that lists bare `gemini-3.8-flash` is now
  **denied** when a thinking budget rewrites the request to `antigravity/gemini-3.8-flash-high`.
  This fails closed, and it matches how prefixed ids with effort variants already behave. Admins
  may still see it as a regression.
- The help text says keys scoped to other providers "lose access". The other side is not
  mentioned: a key that lists a bare id now silently spends **Antigravity** credentials. Consider
  saying both.
- With the toggle on, each bare-id resolution runs four uncached SQLite reads. A restricted key
  on `/v1/models` multiplies that by the number of bare entries. This is acceptable for local
  SQLite and follows the plan's choice to skip caching.

## Verification

- `npx vitest run unit/antigravity-bare-model-routing.test.js unit/gemini-model-effort.test.js unit/gemini-native-endpoint.test.js`
  passed 36 of 36.
- `npx vitest run --reporter=json` was run, then `node __baseline__/verify-no-regression.mjs`.
  It reported 9 pass→fail tests, all in the known pre-existing set: 7 in `golden-url-header`
  (cline, clinepass, codebuddy-cn/intl, kimi, minimax-code/-global), 1 in
  `combo-credit-fallback`, and 1 in `headroom-responses-format`. None of these touch the changed files.

## Unresolved questions

- Should key-access fail closed when the bare resolver errors, or is the documented fail-open
  acceptable given the narrow window?
