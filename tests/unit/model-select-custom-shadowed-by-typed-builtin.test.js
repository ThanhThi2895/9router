/**
 * A custom LLM model whose id matches a non-llm built-in (antigravity's
 * "gemini-3.1-flash-image" is a built-in image model) must still appear in
 * the LLM combo picker. The picker used to dedupe customs against every
 * built-in id, then drop the image built-in via the kind filter, so neither
 * entry survived.
 *
 * ModelSelectModal.js is JSX and cannot be imported here without a JSX
 * transform, so the dedupe source is asserted directly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import { getModelsByProviderId, getModelKind } from "../../src/shared/constants/models.js";

describe("ModelSelectModal custom model shadowed by typed built-in", () => {
  let src;
  beforeAll(() => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    src = fs.readFileSync(fileUrl, "utf-8");
  });

  it("antigravity ships gemini-3.1-flash-image as a non-llm built-in", () => {
    const builtIn = getModelsByProviderId("antigravity").find((m) => m.id === "gemini-3.1-flash-image");
    expect(builtIn).toBeTruthy();
    expect(getModelKind(builtIn)).toBe("image");
  });

  it("dedupes custom models only against kind-filtered built-ins", () => {
    expect(src).toMatch(/const visibleHardcoded = filterByKind\(\s*hardcodedModels\.map\(/);
    expect(src).toMatch(/const hardcodedIds = new Set\(visibleHardcoded\.map\(\(m\) => m\.id\)\)/);
    expect(src).not.toMatch(/const hardcodedIds = new Set\(hardcodedModels\.map/);
  });
});
