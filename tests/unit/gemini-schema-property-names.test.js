import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

const NAMES = ["title", "format", "default", "items", "properties", "required", "const", "enum", "type"];

describe("cleanJSONSchemaForAntigravity keeps parameters named like schema keywords", () => {
  it("never treats keys of a properties map as keywords", () => {
    const schema = {
      type: "object",
      title: "tool",
      properties: Object.fromEntries(
        NAMES.map(n => [n, { type: "string", title: `${n} param`, format: "uri", default: "x" }])
      ),
      required: NAMES,
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));

    expect(Object.keys(cleaned.properties)).toEqual(NAMES);
    for (const n of NAMES) {
      expect(cleaned.properties[n]).toEqual({ type: "string" });
    }
    expect(cleaned.required).toEqual(NAMES);
    expect(cleaned.title).toBeUndefined();
  });

  it("keeps keyword-named parameters in nested objects and array items", () => {
    const schema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: {
            type: "object",
            properties: Object.fromEntries(NAMES.map(n => [n, { type: "number" }])),
            required: ["items", "properties"],
          },
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    const item = cleaned.properties.list.items;

    expect(Object.keys(item.properties)).toEqual(NAMES);
    expect(item.required).toEqual(["items", "properties"]);
  });

  it("still applies const/enum/type handling to the property schemas themselves", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        const: { const: "a" },
        enum: { enum: [1, 2] },
        type: { type: ["string", "null"] },
      },
    });

    expect(cleaned.properties.const).toEqual({ type: "string", enum: ["a"] });
    expect(cleaned.properties.enum).toEqual({ type: "string", enum: ["1", "2"] });
    expect(cleaned.properties.type).toEqual({ type: "string" });
  });
});
