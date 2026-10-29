import { getSettings, getProviderConnections, getCustomModels, getDisabledModels } from "@/lib/db/index.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import REGISTRY from "open-sse/providers/registry/index.js";

const AG_ENTRY = REGISTRY.find((entry) => entry.id === "antigravity");
const AG_ID = AG_ENTRY.id;
const AG_ALIASES = new Set([AG_ID, AG_ENTRY.alias, ...(AG_ENTRY.aliases || [])].filter(Boolean));

/**
 * Ids routable on Antigravity for bare-model routing, or null when the rule is inactive
 * (setting off or no active Antigravity connection).
 */
export async function getAntigravityBareModelIds() {
  const settings = await getSettings();
  if (settings?.antigravityBareModelRouting !== true) return null;

  const connections = (await getProviderConnections({ provider: AG_ID })).filter((c) => c.isActive !== false);
  if (connections.length === 0) return null;

  const ids = new Set();
  const staticIds = getModelsByProviderId(AG_ID).map((m) => m.id);
  for (const conn of connections) {
    const enabled = conn.providerSpecificData?.enabledModels;
    const list = Array.isArray(enabled) && enabled.length > 0 ? enabled : staticIds;
    for (const id of list) ids.add(id);
  }

  for (const m of await getCustomModels()) {
    if (!AG_ALIASES.has(m.providerAlias)) continue;
    if (m.type && m.type !== "llm" && m.type !== "image") continue;
    ids.add(m.id);
  }

  const disabled = await getDisabledModels();
  for (const key of AG_ALIASES) {
    for (const id of disabled[key] || []) ids.delete(id);
  }

  return ids;
}

export async function resolveAntigravityBareModel(modelId) {
  try {
    const ids = await getAntigravityBareModelIds();
    return ids?.has(modelId) ? { provider: AG_ID, model: modelId } : null;
  } catch {
    return null;
  }
}
