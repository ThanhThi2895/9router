import { FORMATS } from "../formats.js";
import { OPENAI_HOSTED_TOOL, GEMINI_TOOL, CLAUDE_WEB_SEARCH_TYPE_PREFIX } from "../schema/index.js";

// Gemini-family targets run a hosted web search as googleSearch grounding.
export const GROUNDING_TARGETS = new Set([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY]);

// Zed (transport openai) fronts Google models and builds a Gemini request itself,
// so its Gemini models ground too; its other models keep the legacy translation.
const ZED_PROVIDER_ID = "zed";
export const supportsWebSearchGrounding = (targetFormat, provider, model) =>
  GROUNDING_TARGETS.has(targetFormat)
  || (provider === ZED_PROVIDER_ID && /gemini/i.test(model || ""));

export const isHostedWebSearchTool = (t) =>
  t?.type === OPENAI_HOSTED_TOOL.WEB_SEARCH || t?.type === OPENAI_HOSTED_TOOL.WEB_SEARCH_PREVIEW
  || t?.type === GEMINI_TOOL.GOOGLE_SEARCH_SNAKE; // OpenAI-shaped {type:"google_search"}
export const isGeminiSearchTool = (t) => !!(t?.[GEMINI_TOOL.GOOGLE_SEARCH] || t?.[GEMINI_TOOL.GOOGLE_SEARCH_SNAKE]);
const CLAUDE_WEB_SEARCH_TYPE = new RegExp(`^${CLAUDE_WEB_SEARCH_TYPE_PREFIX}\\d{8}$`); // web_search_20250305, web_search_20260209
export const isClaudeWebSearchTool = (t) => CLAUDE_WEB_SEARCH_TYPE.test(t?.type || "");

/** Whether a client body (any source format) asks for a web search tool. */
export function requestsWebSearch(body) {
  const tools = body?.tools || body?.request?.tools;
  return Array.isArray(tools)
    && tools.some(t => isHostedWebSearchTool(t) || isGeminiSearchTool(t) || isClaudeWebSearchTool(t));
}

// googleSearch next to client functions is unverified upstream, so it is dropped (logged once).
let searchDroppedLogged = false;

/** Gemini tool groups: one functionDeclarations group, googleSearch only when there are no functions. */
export function geminiToolGroups(functionDeclarations, wantsSearch) {
  if (wantsSearch && functionDeclarations.length > 0 && !searchDroppedLogged) {
    searchDroppedLogged = true;
    console.debug("[gemini] googleSearch dropped: not sent together with function declarations");
  }
  return [
    ...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
    ...(wantsSearch && functionDeclarations.length === 0 ? [{ [GEMINI_TOOL.GOOGLE_SEARCH]: {} }] : []),
  ];
}

/**
 * Copy of a Claude body without its Anthropic server web-search tools, or null when it has none.
 * The caller's body is left intact so the stream can still see that a search was requested.
 * max_uses, allowed_domains, blocked_domains and user_location are dropped: googleSearch has no equivalent.
 */
export function withoutClaudeWebSearchTools(body) {
  if (!Array.isArray(body?.tools)) return null;
  const removed = body.tools.filter(isClaudeWebSearchTool);
  if (removed.length === 0) return null;
  const removedNames = new Set(removed.map(t => t.name).filter(Boolean));
  const out = { ...body, tools: body.tools.filter(t => !isClaudeWebSearchTool(t)) };
  if (out.tools.length === 0) delete out.tools;
  // A tool_choice naming a removed tool would point the OpenAI hop at a missing function.
  if (out.tool_choice?.type === "tool" && removedNames.has(out.tool_choice.name)) delete out.tool_choice;
  return out;
}

/** Append one hosted web_search tool to an OpenAI body unless one is already there. */
export function addHostedWebSearchTool(body) {
  if (!Array.isArray(body.tools)) body.tools = [];
  if (body.tools.some(isHostedWebSearchTool)) return;
  body.tools.push({ type: OPENAI_HOSTED_TOOL.WEB_SEARCH });
}
