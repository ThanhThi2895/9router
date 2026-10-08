---
title: Antigravity Add Model hidden by image built-in
date: 2026-10-08
summary: Custom LLM row for gemini-3.1-flash-image was deduped against a non-llm built-in
---

# Antigravity Add Model hidden by image built-in

## What happened
On the Antigravity provider page, clicking "Add Model" for `gemini-3.1-flash-image` seemed to do nothing. The POST to `/api/models/custom` worked, but the new row never showed up.

## Root cause
The registry (`open-sse/providers/registry/antigravity.js`) already has `gemini-3.1-flash-image` as a built-in with `kind: "image"`. The LLM chip list filters it out. But `getProviderCustomModelRows` got the unfiltered `models` list as `builtInModels`, so it treated the user's new LLM row as a duplicate and dropped it.

## Decision
Pass the LLM-filtered `allModels` as `builtInModels` in `src/app/(dashboard)/dashboard/providers/[id]/page.js`. That way rows are only deduped against chips that are actually shown.

## Next steps
- Check in the running dashboard that the row appears after adding it. This was not run here because node_modules is not installed.
- Image generation already works without this: use `ag/gemini-3.1-flash-image` on `/v1/images/generations`, or open the image page at `/dashboard/media-providers/image/antigravity`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
