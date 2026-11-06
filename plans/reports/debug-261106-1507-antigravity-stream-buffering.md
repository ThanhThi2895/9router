# Debug: Antigravity/Gemini streams arrive in one burst via proxy.thinguyen.xyz

## Outcome

There are two separate causes.

1. **nginx buffering, fixed in this repo.** Client-facing SSE responses (`SSE_HEADERS_CORS`, used by `open-sse/handlers/chatCore/streamingHandler.js:116` and `open-sse/handlers/responsesHandler.js:91`) did not send `X-Accel-Buffering: no`. The VPS fronts the container with nginx-proxy-manager (openresty). Its host config `/data/nginx/proxy_host/3.conf` leaves `proxy_buffering` at the default (on) and does not ignore `X-Accel-Buffering`, so nginx held the stream and released it in bursts or all at once at the end. The fix adds the header to `SSE_HEADERS_CORS`.
2. **The long silent wait before the first byte comes from the Antigravity upstream, not from this repo.** On thinking-heavy requests, Google's `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` returns no headers or bytes until thinking finishes (60–199s observed), even with `includeThoughts: true`. After that it streams the reply text incrementally. No proxy or reverse-proxy setting can shorten this wait.

## Evidence (all probes run on the VPS on 2026-11-06; API key and OAuth token read read-only inside the host, never printed)

| Layer probed | Prompt / model | Result |
|---|---|---|
| Raw upstream fetch from the container (no 9router code) | short, `gemini-3.8-flash-high` | Headers at +199.0s, all 15 chunks by +200.8s |
| Raw upstream | ~1200-word essay, `-high` | Headers at +60.0s, then 121 chunks spread to +91.9s (streams incrementally) |
| Raw upstream | same essay, `-low` | Headers at +2.2s, 70 chunks spread to +13.0s |
| 9router container port `127.0.0.1:20128` | essay, `ag/gemini-3.8-flash-low` | 45 events spread from +2.2s to +8.8s (9router streams correctly) |
| 9router container port | short, `-high` | Headers at +152.3s (9router log: TTFT 152104ms, DONE 153818ms), matching the upstream wait |
| nginx direct (`--resolve proxy.thinguyen.xyz:443:127.0.0.1`) | essay, `-low` | Every event inside ~10–60ms at +2.7s / +6.5s, a burst at the end |
| Cloudflare (public URL) | essay, `-low` | Burst at +10.3s, plus one more flush at +12.2s |

The response headers confirm it. The container sends `content-type: text/event-stream` and `cache-control: no-cache` with no `x-accel-buffering`. nginx answers as `Server: openresty`.

Because each probe was a separate generation, chunk counts differ between rows. The comparison that matters is the spread: events spread over time at the container port and arrive collapsed at nginx and Cloudflare.

## Change

- `open-sse/utils/sseConstants.js`: `SSE_HEADERS_CORS` gains `"X-Accel-Buffering": "no"`.
- `tests/unit/sse-no-proxy-buffering.test.js`: checks the constant and the header on a real `handleStreamingResponse` response. It fails 2/2 without the fix and passes 2/2 with it.

## Verification

- `npx eslint` on both files: clean.
- Full vitest: 4389 pass, 27 fail. `verify-no-regression.mjs` reports the same 9 pass→fail already recorded for the parent commit in `verify-261030-1450-nonstream-claude-message.md` (golden-url-header ×7, combo-credit-fallback, headroom-responses-format). None are new.
- **Not live-verified:** the fix is not deployed (image `ghcr.io/thanhthi2895/9router:vps`). After deploy, re-run a long `-low` prompt through nginx and through the public URL and expect the events to spread over time.

## If the header alone is not enough (outside the repo; not changed)

- nginx-proxy-manager, host proxy.thinguyen.xyz, Advanced tab: `proxy_buffering off;` (and optionally `proxy_cache off;`) makes nginx stop relying on the header.
- Cloudflare normally passes `text/event-stream` through without buffering. These probes could not isolate Cloudflare from nginx, because nginx already buffered in front of it. If bursts remain at the public URL after nginx streams, check for any Worker or Snippet on the route.

## Unresolved

- The upstream wait before the first byte on `-high` models (Google holds the response during thinking) cannot be fixed in the proxy. Using `-low`/`-medium` tiers shortens it.
