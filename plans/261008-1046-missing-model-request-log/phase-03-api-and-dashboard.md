# Phase 3 — API route and dashboard tab

## Files
- Create `src/app/api/usage/missing-models/route.js`:
  - `GET` — query `reason`, `includeResolved`, `page`, `pageSize` (1–100, same validation style as `src/app/api/usage/request-details/route.js`).
  - `PATCH` — body `{ id, resolved }`.
  - `DELETE` — `?id=` deletes one, no id clears all.
  - Path stays under `/api/usage` which `src/dashboardGuard.js` already protects; do not add it to `PUBLIC_API_PATHS`.
- Create `src/app/(dashboard)/dashboard/usage/components/MissingModelsTab.js`, modelled on `RequestDetailsTab.js`: reason filter, "show resolved" toggle, table (model, reason, provider, endpoint, count, first seen, last seen, last error), row actions Mark resolved / Delete, header action Clear all with confirm. Render all values as text.
- Modify `src/app/(dashboard)/dashboard/usage/page.js` to add the tab.
- Add i18n strings if the usage page uses the locale system (check `src/app/api/locale` usage in `RequestDetailsTab.js`).

Read the relevant guide in `node_modules/next/dist/docs/` for route handlers before writing the route (project CLAUDE.md: this Next.js version has breaking changes).

## Validation
- `npx eslint src/app/api/usage/missing-models src/app/(dashboard)/dashboard/usage`.
- Manual: logged-out `curl /api/usage/missing-models` is rejected; logged-in dashboard shows rows from phase 2 and actions work.

## Risk / rollback
UI-only plus an authenticated route. Rollback = remove files and the tab entry.
