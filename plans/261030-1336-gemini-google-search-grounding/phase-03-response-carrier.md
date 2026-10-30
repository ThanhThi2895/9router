---
phase: 03
title: Response carrier and /v1beta round-trip
status: pending
effort: 3h
depends_on: [01]
---

# Phase 03: Response carrier and /v1beta round-trip

## Goal
Upstream `groundingMetadata` survives the Gemini→OpenAI→client hop, both streamed and non-streamed. A `/v1beta` client gets `candidates[0].groundingMetadata` back unchanged. An OpenAI client gets `url_citation` annotations.

## Files
| Action | Path | Change |
|---|---|---|
| modify | `open-sse/translator/concerns/webSearch.js` | Add `groundingToAnnotations(gm)` and `GROUNDING_FIELD = "grounding_metadata"`. |
| modify | `open-sse/translator/response/gemini-to-openai.js` | Keep `candidate.groundingMetadata` in `state.groundingMetadata` (latest wins; this follows D4). Attach `annotations` and `grounding_metadata` to the delta of the finish chunk. If grounding arrives after `state.finishReason` is set, emit a lone `{annotations, grounding_metadata}` chunk with no finish reason. |
| modify | `open-sse/handlers/chatCore/sseToJsonHandler.js` | `parseSSEToOpenAIResponse`: concatenate `delta.annotations` into `message.annotations`, and keep the last `delta.grounding_metadata` as `message.grounding_metadata`. |
| modify | `open-sse/handlers/chatCore/nonStreamingHandler.js` | In the Gemini branch (around line 111): set `message.annotations` and `message.grounding_metadata` from `candidate.groundingMetadata`. |
| modify | `open-sse/translator/response/openai-to-antigravity.js` | If `delta.grounding_metadata` is present, set `candidate.groundingMetadata` on that chunk's candidate. Make sure a chunk that carries only grounding is not dropped by the "skip empty non-finish chunks" check. |
| modify | `src/app/api/v1beta/models/[...path]/route.js` | `convertOpenAIResponseToGemini`: pass `message.grounding_metadata` into the synthetic chunk's delta. The stream path needs no change because it already uses `openaiToAntigravityResponse`. |

## `groundingToAnnotations`
```js
// groundingSupports tie answer spans to chunks; without them, cite each source once with no span.
export function groundingToAnnotations(gm) {
  const chunks = Array.isArray(gm?.groundingChunks) ? gm.groundingChunks : [];
  const sources = chunks.map((c) => c?.web?.uri ? { url: c.web.uri, title: c.web.title || c.web.domain || "" } : null);
  const out = [];
  for (const s of gm?.groundingSupports || []) {
    const { startIndex, endIndex } = s?.segment || {};
    for (const i of s?.groundingChunkIndices || []) {
      const src = Number.isInteger(i) ? sources[i] : null;
      if (src) out.push({ type: "url_citation", url_citation: { ...src, start_index: startIndex ?? 0, end_index: endIndex ?? 0 } });
    }
  }
  if (out.length === 0) for (const src of sources) if (src) out.push({ type: "url_citation", url_citation: src });
  return out;
}
```
Gemini segment indexes are byte offsets into UTF-8 text, while OpenAI expects character offsets. For ASCII text they are the same. Pass them through unchanged and note the difference in a comment instead of re-encoding the text, which this layer does not keep.

## Notes
- `grounding_metadata` is copied as-is. Do not rebuild it. `/v1beta` clients may read `searchEntryPoint.renderedContent` (Google's display requirement for grounded results).
- Do not put grounding on every chunk. Clients concatenate `annotations` across deltas, so duplicates would multiply the citations.
- The state field must be named `groundingMetadata`, which does not clash with the shared `state.toolCalls` noted at `gemini-to-openai.js:33-36`.

## Tests (new `tests/unit/gemini-grounding-response.test.js`)
Use the scrubbed phase 01 fixtures inline.
1. Stream: feeding the fixture chunks through `geminiToOpenAIResponse` puts both fields exactly once, on the finish chunk. A late grounding chunk produces one lone chunk.
2. Non-stream via `parseSSEToOpenAIResponse`: the message has the annotations and the `grounding_metadata` deep-equals the fixture.
3. `nonStreamingHandler.translateNonStreamingResponse(antigravityJson, ANTIGRAVITY, OPENAI)` gives the same result as test 2.
4. `/v1beta` stream (mock `handleChat` the same way `gemini-native-tools.test.js` does): the last SSE event's `candidates[0].groundingMetadata` deep-equals the fixture.
5. `/v1beta` JSON: the same result for `:generateContent`.
6. Ungrounded regression: the existing `gemini-native-tools.test.js` and `antigravity-nonstream-usage-3260.test.js` pass unchanged, and the outputs have no `annotations` key.

## Validation
```bash
cd tests && npx vitest run unit/gemini-grounding-response.test.js unit/gemini-native-tools.test.js unit/gemini-native-endpoint.test.js unit/antigravity-nonstream-usage-3260.test.js
```

## Risk and rollback
All new fields are additive and appear only when upstream sends grounding. Revert the files to roll back.
