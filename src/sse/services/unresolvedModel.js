import { recordUnresolvedModelEvent } from "@/lib/db/repos/unresolvedModelsRepo.js";

// Explicit phrases only: a loose "model ... invalid" also matches context-length and
// request-validation 400s, which are not missing models.
export const MODEL_NOT_FOUND_PATTERNS = [
  /model[_ -]?not[_ -]?found/i,
  /no such model/i,
  /(unknown|invalid|unsupported|unrecognized) model\b/i,
  /\bmodel\b[^.\n]{0,80}\b(does not exist|doesn't exist|is not supported|not supported|is unknown|not available)/i,
];

export function isModelNotFoundError(status, error) {
  if (status === 404) return true;
  if (status !== 400 && status !== 422) return false;
  if (!error) return false;
  const msg = typeof error === "string" ? error : (error.message || JSON.stringify(error));
  return MODEL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(msg));
}

// Account fallback retries the same request on every connection, so upstream
// "model not found" is committed once, and only if the final attempt failed that way.
export function createUpstreamModelNotFoundRecorder(base) {
  let pending = null;
  return {
    observe(status, error) {
      pending = isModelNotFoundError(status, error) ? { error } : null;
    },
    commit() {
      if (!pending) return;
      const { error } = pending;
      pending = null;
      recordUnresolvedModel({ ...base, reason: "upstream_model_not_found", error });
    },
  };
}

export function recordUnresolvedModel({
  request,
  endpoint,
  requestedModel,
  reason,
  provider,
  error,
}) {
  try {
    let resolvedEndpoint = endpoint;
    if (!resolvedEndpoint && request?.url) {
      try {
        resolvedEndpoint = new URL(request.url).pathname;
      } catch {}
    }
    const userAgent = request?.headers?.get?.("user-agent") || "";
    const errorStr = error
      ? (typeof error === "string" ? error : (error.message || JSON.stringify(error)))
      : null;

    recordUnresolvedModelEvent({
      endpoint: resolvedEndpoint || "",
      requestedModel: requestedModel ?? "",
      reason,
      provider: provider || null,
      error: errorStr,
      userAgent,
    });
  } catch (err) {
    // Fail-open
    console.error("[unresolvedModel] record error:", err);
  }
}
