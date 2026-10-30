import { CLAUDE_BLOCK, CLAUDE_WEB_SEARCH } from "../schema/index.js";

// Carrier for Gemini Google Search grounding across the OpenAI pivot.
// `annotations` is the standard OpenAI url_citation shape; `grounding_metadata`
// is the raw Gemini groundingMetadata, copied unchanged so /v1beta clients get
// it back whole (queries, supports, searchEntryPoint).
export const GROUNDING_FIELD = "grounding_metadata";

// groundingSupports tie answer spans to chunks; without them, cite each source once with no span.
// Gemini segment indexes are byte offsets into UTF-8 text while OpenAI expects
// character offsets. They are equal for ASCII; passed through unchanged because
// this layer does not keep the text to re-encode.
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

// Delta/message fields carrying grounding; empty object when there is none.
export function groundingFields(gm) {
  if (!gm || typeof gm !== "object") return {};
  const annotations = groundingToAnnotations(gm);
  return { ...(annotations.length > 0 && { annotations }), [GROUNDING_FIELD]: gm };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Random Anthropic-style server tool id; never derived from upstream data.
function newServerToolUseId() {
  let n = BigInt(`0x${globalThis.crypto.randomUUID().replace(/-/g, "")}`);
  let out = "";
  while (n > 0n) { out = BASE62[Number(n % 62n)] + out; n /= 62n; }
  return CLAUDE_WEB_SEARCH.TOOL_USE_ID_PREFIX + out.padStart(24, "0").slice(0, 24);
}

// Anthropic counts one request per search query; at least one when grounded.
export function groundingQueryCount(gm) {
  const queries = Array.isArray(gm?.webSearchQueries) ? gm.webSearchQueries : [];
  return Math.max(1, queries.length);
}

// Gemini groundingMetadata -> [server_tool_use, web_search_tool_result].
// One tool use even with several queries: Gemini does not tie chunks to queries.
export function groundingToClaudeBlocks(gm) {
  const queries = Array.isArray(gm?.webSearchQueries) ? gm.webSearchQueries : [];
  const sources = new Map();
  for (const c of Array.isArray(gm?.groundingChunks) ? gm.groundingChunks : []) {
    const url = c?.web?.uri;
    if (url && !sources.has(url)) sources.set(url, c.web.title || c.web.domain || "");
  }
  const id = newServerToolUseId();
  return [
    { type: CLAUDE_BLOCK.SERVER_TOOL_USE, id, name: CLAUDE_WEB_SEARCH.TOOL_NAME, input: { query: queries[0] || "" } },
    {
      type: CLAUDE_BLOCK.WEB_SEARCH_TOOL_RESULT,
      tool_use_id: id,
      content: [...sources].map(([url, title]) => ({
        type: CLAUDE_WEB_SEARCH.RESULT_ITEM, url, title, encrypted_content: "", page_age: null,
      })),
    },
  ];
}
