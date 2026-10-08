---
title: Antigravity image models ignored reference images
date: 2026-10-08
summary: Reference images were dropped in the Antigravity image_gen request and in the Gemini to OpenAI translator; both fixed on a branch off master
---

# Antigravity image models ignored reference images

## What happened
Sending antigravity/gemini-3.1-flash-image a reference PNG and asking it to redraw the same character returned a different character, as if the model had only seen the text prompt.

## Root cause
- `open-sse/executors/antigravity.js`: the image_gen branch of `transformRequest` rebuilt `contents` from text parts only, so `inlineData` and `fileData` reference images never reached the upstream model.
- `open-sse/translator/request/gemini-to-openai.js`: on the `/v1beta/models/{model}:generateContent` path, the translator only mapped camelCase `inlineData`. Snake_case `inline_data` (the form used in Google's REST examples) and all `fileData`/`file_data` parts were dropped before any executor saw them.

## Changes
- The executor keeps text plus inline and file media parts and drops chat-only parts such as tool calls and signatures. A turn that contains only an image is now kept too.
- The translator maps both key casings of inline data to data-URI `image_url`, and maps file data to an `image_url` holding its URI.
- Added the regression test `tests/unit/antigravity-image-reference.test.js`. All 5 cases failed before the fix and pass after it.
- Branch `thinguyen/fix/antigravity-image-reference`, commit 7083e1a4. The uncommitted work in the main tree was not touched.

## Verification
Full vitest suite: 105 failing before the change, 100 after. The only difference is the 5 new tests now passing, with no new failures compared with master.

## Next steps
- Run a live request against Antigravity with a reference image. The fix has not been verified against the real upstream yet.
- Remote `fileData` URIs are now fetched server-side through the existing SSRF-guarded prefetch, the same path OpenAI `image_url` already uses.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
