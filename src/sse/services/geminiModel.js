import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveModelAlias } from "./model.js";

/**
 * Model-name resolution for the Gemini-native endpoint (`/v1beta/models/...`).
 *
 * Gemini clients (Gemini CLI, Antigravity CLI) carry the reasoning effort in the
 * request body — `generationConfig.thinkingConfig.thinkingBudget` — never in the
 * model name; the name they send is identical whether the user picked "low" or
 * "high". Providers here expose effort as separate model ids instead
 * (`gemini-3.8-flash-low` / `-medium` / `-high`), so the endpoint has to move the
 * effort from the body into the name, and only to a variant that actually exists.
 */

// Effort suffixes providers publish, ordered from cheapest to most thorough.
const EFFORTS = ["extra-low", "low", "medium", "high"];

/**
 * Reasoning effort the client asked for, or null when it did not say.
 *
 * Gemini CLI sends 1000 for low, 4000 for medium and -1 (unlimited) for high.
 * The bounds below are wider than those three values so models that publish
 * different budgets still land on a sensible effort.
 */
export function effortFromThinkingBudget(budget) {
  if (typeof budget !== "number" || Number.isNaN(budget)) return null;
  if (budget < 0 || budget > 8000) return "high";
  if (budget <= 2000) return "low";
  return "medium";
}

/**
 * Effort suffixes ordered by distance from the requested one. Ties go to the
 * higher effort: silently downgrading reasoning quality is worse than spending
 * a little more, and the client cannot tell that a substitution happened.
 */
function effortOrder(effort) {
  const want = EFFORTS.indexOf(effort);
  if (want < 0) return [...EFFORTS];
  return EFFORTS
    .map((name, index) => ({ name, index }))
    .sort((a, b) => Math.abs(a.index - want) - Math.abs(b.index - want) || b.index - a.index)
    .map((entry) => entry.name);
}

/**
 * Candidate model ids to look for, best fit first. A bare name (no suffix) wins
 * when the client stated no effort and loses otherwise: a suffix pins the effort,
 * a bare name leaves it to the provider.
 */
function candidates(modelId, effort) {
  const variants = effortOrder(effort).map((name) => `${modelId}-${name}`);
  return effort === null ? [modelId, ...variants] : [...variants, modelId];
}

/**
 * Which provider a model string names, and the id within it. The alias table
 * wins when it has an entry, otherwise the first slash separates the two — model
 * ids may contain further slashes (e.g. "openrouter/meta-llama/llama-3").
 *
 * Returns null when neither applies, which is the signal to leave the name be.
 */
async function locate(modelStr) {
  // Picking a nicer name is a convenience, never a reason to fail a request: if
  // the alias store is unreachable, fall through to parsing the name as given.
  try {
    const alias = await resolveModelAlias(modelStr);
    if (alias?.provider && alias?.model) {
      return { provider: alias.provider, modelId: alias.model };
    }
  } catch {
    // fall through
  }

  const at = modelStr.indexOf("/");
  if (at < 0) return null;
  return { provider: modelStr.slice(0, at), modelId: modelStr.slice(at + 1) };
}

/**
 * Resolve the model a Gemini-native request should actually run against.
 *
 * Order: model alias table first (an explicit mapping is a deliberate choice and
 * is never second-guessed), then the effort variant that exists in the provider
 * catalog. Anything we cannot place is returned untouched so the normal chat
 * pipeline reports the failure as it always has.
 */
export async function resolveGeminiModel(modelStr, body) {
  const target = await locate(modelStr);
  if (!target) return modelStr; // no provider to look a catalog up in

  const asGiven = `${target.provider}/${target.modelId}`;

  // An id that already carries an effort suffix was pinned on purpose.
  if (EFFORTS.some((name) => target.modelId.endsWith(`-${name}`))) return asGiven;

  const known = getModelsByProviderId(target.provider);
  if (!Array.isArray(known) || known.length === 0) return asGiven;

  const effort = effortFromThinkingBudget(body?.generationConfig?.thinkingConfig?.thinkingBudget);
  const ids = new Set(known.map((entry) => entry?.id).filter(Boolean));
  const match = candidates(target.modelId, effort).find((id) => ids.has(id));

  return match ? `${target.provider}/${match}` : asGiven;
}
