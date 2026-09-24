// Content-free structural summary of a Gemini-family request (Gemini, Gemini CLI, Antigravity).
// Google answers malformed history with a bare 400 INVALID_ARGUMENT that names no field, and
// request bodies are too sensitive to log, so on a 400 we log only the shape of the last turns
// (roles, part kinds, sizes, ids, arg types) plus anomalies known to trigger that error.

const DEFAULT_MAX_TURNS = 8;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function typeOfValue(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function describePart(part) {
  if (!isPlainObject(part)) return `invalid(${typeOfValue(part)})`;
  const sig = part.thoughtSignature ? `+sig(${String(part.thoughtSignature).length})` : "";
  if (part.functionCall) {
    const fc = part.functionCall;
    return `fc(${fc.name},id=${fc.id ?? "-"},args=${typeOfValue(fc.args)})${sig}`;
  }
  if (part.functionResponse) {
    const fr = part.functionResponse;
    return `fr(${fr.name},id=${fr.id ?? "-"},resp=${typeOfValue(fr.response)})`;
  }
  if (part.inlineData) return `inline(${part.inlineData.mimeType},${part.inlineData.data?.length ?? 0})`;
  if (part.fileData) return `file(${part.fileData.mimeType})`;
  if ("text" in part) {
    if (typeof part.text !== "string") return `text(${typeOfValue(part.text)})${sig}`;
    return `${part.thought ? "thought" : "text"}(${part.text.length})${sig}`;
  }
  return `other(${Object.keys(part).join("|") || "empty"})${sig}`;
}

function findAnomalies(contents) {
  const anomalies = [];
  if (contents[0]?.role !== "user") anomalies.push(`first turn role=${contents[0]?.role}`);

  contents.forEach((content, i) => {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    if (parts.length === 0) anomalies.push(`#${i} has no parts`);
    if (i > 0 && contents[i - 1]?.role === content?.role) anomalies.push(`#${i} repeats role ${content?.role}`);

    for (const part of parts) {
      if (part?.functionCall && !isPlainObject(part.functionCall.args)) {
        anomalies.push(`#${i} fc ${part.functionCall.name} args=${typeOfValue(part.functionCall.args)}`);
      }
      if ("text" in (part || {}) && typeof part.text !== "string") anomalies.push(`#${i} non-string text`);
    }

    // Every model turn with functionCalls must be answered by the next turn with the same calls.
    const calls = parts.filter(p => p?.functionCall).map(p => p.functionCall);
    const responses = parts.filter(p => p?.functionResponse).map(p => p.functionResponse);
    if (responses.length > 0) {
      const prevCalls = (contents[i - 1]?.parts || []).filter(p => p?.functionCall).map(p => p.functionCall);
      if (prevCalls.length === 0) {
        anomalies.push(`#${i} has ${responses.length} fr without preceding fc`);
      } else if (prevCalls.length !== responses.length) {
        anomalies.push(`#${i} fr count ${responses.length} != fc count ${prevCalls.length} in #${i - 1}`);
      } else {
        const callIds = new Set(prevCalls.map(c => c.id).filter(Boolean));
        const unmatched = responses.filter(r => r.id && callIds.size > 0 && !callIds.has(r.id));
        if (unmatched.length) anomalies.push(`#${i} fr ids not in #${i - 1}: ${unmatched.map(r => r.id).join(",")}`);
      }
    }
    if (calls.length > 0 && i < contents.length - 1) {
      const next = contents[i + 1]?.parts || [];
      if (!next.some(p => p?.functionResponse)) anomalies.push(`#${i} fc not answered by #${i + 1}`);
    }
  });
  return anomalies;
}

/**
 * Returns a multi-line summary, or null when the body is not Gemini-shaped.
 * Never includes text, arguments or response values — only structure.
 */
export function describeGeminiRequestShape(body, maxTurns = DEFAULT_MAX_TURNS) {
  const request = body?.request || body;
  const contents = request?.contents;
  if (!Array.isArray(contents)) return null;

  try {
    const decls = (request.tools || []).reduce((n, t) => n + (t?.functionDeclarations?.length || 0), 0);
    const header = [
      `contents=${contents.length}`,
      `tools=${decls}`,
      `system=${request.systemInstruction?.parts?.length || 0}`,
      `toolMode=${request.toolConfig?.functionCallingConfig?.mode || "-"}`,
      `gen=${Object.keys(request.generationConfig || {}).join("|") || "-"}`,
    ].join(" ");

    const start = Math.max(0, contents.length - maxTurns);
    const turns = contents.slice(start).map((content, k) => {
      const parts = Array.isArray(content?.parts) ? content.parts.map(describePart).join(" ") : "no-parts";
      return `#${start + k} ${content?.role}: ${parts}`;
    });

    const anomalies = findAnomalies(contents);
    const lines = [header, ...turns];
    lines.push(anomalies.length ? `anomalies: ${anomalies.slice(0, 10).join("; ")}` : "anomalies: none detected");
    return lines.join("\n    ");
  } catch (error) {
    return `shape summary failed: ${error.message}`;
  }
}
