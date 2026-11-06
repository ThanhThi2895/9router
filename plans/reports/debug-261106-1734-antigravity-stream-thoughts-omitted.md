# Antigravity gemini-3.8-flash-high: thinking text missing on Claude-format requests

Date: 2026-11-06. Status: diagnosed. No repo fix for the live symptom (upstream behaviour).

## Summary

The thinking param does not decide whether thought text comes back. Stream vs non-stream does.
The antigravity upstream omits thought text from `streamGenerateContent` but returns it from
`generateContent`, for the same request body with `includeThoughts: true`. 9router builds the
same upstream body whether or not the client sends `thinking`, and drops nothing on the way
back. Clients that send `thinking` usually also stream, which makes the symptom look tied to
the thinking param.

## Evidence

### Live requests through the deployed container (127.0.0.1:20128, `/v1/messages`, `ag/gemini-3.8-flash-high`)

| Mode | No thinking | `thinking: {type: "enabled"}` | enabled + `budget_tokens: 4096` |
|---|---|---|---|
| Non-stream | 793 chars of thinking | 698 chars of thinking | none (resolved to level `low`) |
| Stream | 16 chars of thinking | none | none |

The container's per-request log line showed THINK:high for "none" and "enabled", and THINK:low
for the budget case.

### Upstream request body

The deployed `open-sse/` files hash-match HEAD `fc256d35`. The upstream body rebuilt from HEAD
is identical for "none" and "enabled" apart from `requestId` and `sessionId`:
`generationConfig.thinkingConfig = {thinkingLevel: "high", includeThoughts: true}`. The
CAVEMAN and PONYTAIL token savers enabled on the VPS do not read `thinking`.

### Direct upstream calls from inside the container, using that exact body

| Endpoint | Calls | Thought parts returned | Thinking tokens spent |
|---|---|---|---|
| `v1internal:streamGenerateContent?alt=sse` | 8 | 0 in all 8 | 141–183 per call |
| `v1internal:generateContent` | 4 | 1 in all 4 (693–886 chars) | 152–175 per call |

A captured stream contained only `{"text":"391"}` and a part holding just a `thoughtSignature`.
Replaying it through 9router's stream translator (antigravity to claude) produced a text block
only, so nothing is lost inside 9router.

## Related fix found along the way (uncommitted)

`open-sse/handlers/chatCore.js`: a provider-level thinking mode of `on` or `off` used to fall
through and set `reasoning_effort: "on"/"off"` when the client already sent `thinking`. That
resolved Gemini requests to `minimal` with `includeThoughts: false`. The VPS has no
`providerThinking` setting, so this was not the live cause, but it is a real latent bug.
Regression test: `tests/unit/provider-thinking-switch.test.js` (5 pass with the fix, 4 fail
without it).

## Options considered (not taken)

- Non-stream fallback: for antigravity streams where the client wants thinking text, call
  `generateContent` and re-emit the result as SSE. This loses incremental streaming and raises
  time-to-first-token.
- Capture what the official Antigravity client sends to get streamed thoughts (model id,
  headers, fields). This needs a capture of the IDE's traffic.

## Unresolved questions

- Does the budget case (level `low`) ever return thought text from upstream? It was not sampled
  directly.
- How does the official Antigravity IDE get streamed thoughts, if it does?
