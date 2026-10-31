// A standalone grounding chunk (empty content, no finish_reason) trailing the
// finish must not be dropped by the empty-chunk filter on the openai path.
import { describe, it, expect } from "vitest";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const chunk = (delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] });

describe("hasValuableContent grounding", () => {
  it("keeps a chunk carrying grounding_metadata", () => {
    expect(hasValuableContent(chunk({ grounding_metadata: { webSearchQueries: ["q"] } }), FORMATS.OPENAI)).toBeTruthy();
  });
  it("keeps a chunk carrying annotations", () => {
    const annotations = [{ type: "url_citation", url_citation: { url: "https://a.test", title: "a" } }];
    expect(hasValuableContent(chunk({ annotations }), FORMATS.OPENAI)).toBeTruthy();
  });
  it("still drops an empty delta", () => {
    expect(hasValuableContent(chunk({}), FORMATS.OPENAI)).toBeFalsy();
    expect(hasValuableContent(chunk({ annotations: [] }), FORMATS.OPENAI)).toBeFalsy();
  });
});
