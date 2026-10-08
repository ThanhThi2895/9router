---
title: Gemini-native endpoint dropped generated images
date: 2026-10-08
summary: v1beta lost inlineData for antigravity image models on both generateContent and streamGenerateContent; fixed in three places
---

# Gemini-native endpoint dropped generated images

## What happened
Image generation through `/v1beta/models/gemini-3.1-flash-image:*` (alias to `antigravity/gemini-3.1-flash-image`) reached the client with no image. The `agy` client reported "image failed to generate: no image data returned by the model".

## Root cause
chatCore forces `stream=false` for antigravity image models, because upstream supports only `generateContent`. Three things then lost the image:
- `nonStreamingHandler` turned `inlineData` into markdown text inside `content` and kept no structured copy.
- `openaiToAntigravityResponse` ignored `delta.images`, so the image never became an `inlineData` part.
- For `:streamGenerateContent`, the route sent the JSON `chat.completion` through the SSE transformer. That transformer emits only `data:` lines, so the client got an empty stream.

## Decision
- `nonStreamingHandler` now also returns `message.images`, in the same shape the streaming translator uses. The markdown in `content` stays, so OpenAI chat clients see no change.
- `openaiToAntigravityResponse` maps data-URI `delta.images` to `inlineData`. It only parses data URIs and never fetches remote URLs, so there is no SSRF surface.
- The v1beta route passes images through and removes the duplicate markdown base64 copy from the text. When a streaming client gets a JSON body, the route converts it and sends it as a single SSE event.

## Verification
- `tests/unit/gemini-native-image-output.test.js`: 4 tests, red before the fix and green after.
- The 86 pre-existing baseline failures are identical with and without the change.

## Next steps
The first-call 404 "No active credentials for provider: gemini" was out of scope. The user confirmed it was a missing config on their side.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
