// Reference images sent to an Antigravity image model must reach the upstream
// request, both when the body is already Gemini-shaped and when it took the
// Gemini -> OpenAI -> Antigravity hop used by /v1beta/models/{model}:generateContent.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const MODEL = "gemini-3.1-flash-image";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PROMPT = "Redraw this same character waving";
const credentials = { projectId: "synthetic-project", connectionId: "synthetic-connection" };

function imageGenRequest(body) {
  return new AntigravityExecutor().transformRequest(MODEL, body, false, credentials);
}

function mediaParts(output) {
  return output.request.contents.flatMap((c) => c.parts).filter((p) => !("text" in p));
}

function inlineDataOf(part) {
  const inline = part.inlineData || part.inline_data;
  return inline && { mimeType: inline.mimeType || inline.mime_type, data: inline.data };
}

describe("Antigravity image generation keeps reference images", () => {
  it("keeps inlineData and fileData parts next to the prompt", () => {
    const output = imageGenRequest({
      request: {
        contents: [{
          role: "user",
          parts: [
            { text: PROMPT },
            { inlineData: { mimeType: "image/png", data: PNG_BASE64 } },
            { fileData: { mimeType: "image/png", fileUri: "https://example.com/ref.png" } },
          ],
        }],
      },
    });

    expect(output.requestType).toBe("image_gen");
    expect(output.request.contents).toEqual([{
      role: "user",
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: "image/png", data: PNG_BASE64 } },
        { fileData: { mimeType: "image/png", fileUri: "https://example.com/ref.png" } },
      ],
    }]);
  });

  it("keeps an image-only turn instead of dropping it", () => {
    const output = imageGenRequest({
      request: {
        contents: [
          { role: "user", parts: [{ inline_data: { mime_type: "image/png", data: PNG_BASE64 } }] },
          { role: "user", parts: [{ text: PROMPT }] },
        ],
      },
    });

    expect(output.request.contents).toHaveLength(2);
    expect(inlineDataOf(output.request.contents[0].parts[0])).toEqual({ mimeType: "image/png", data: PNG_BASE64 });
  });

  it.each([
    ["camelCase", { inlineData: { mimeType: "image/png", data: PNG_BASE64 } }],
    ["snake_case", { inline_data: { mime_type: "image/png", data: PNG_BASE64 } }],
  ])("survives the Gemini -> OpenAI -> Antigravity hop (%s inline data)", (_label, imagePart) => {
    const geminiBody = { contents: [{ role: "user", parts: [{ text: PROMPT }, imagePart] }] };

    const openaiBody = geminiToOpenAIRequest(MODEL, geminiBody, false);
    expect(openaiBody.messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
    });

    const antigravityBody = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, MODEL, openaiBody, false, credentials, "antigravity");
    const output = imageGenRequest(antigravityBody);

    expect(output.request.contents[0].parts[0]).toEqual({ text: PROMPT });
    const images = mediaParts(output);
    expect(images).toHaveLength(1);
    expect(inlineDataOf(images[0])).toEqual({ mimeType: "image/png", data: PNG_BASE64 });
  });

  it("maps Gemini fileData to an OpenAI image_url", () => {
    const openaiBody = geminiToOpenAIRequest(MODEL, {
      contents: [{
        role: "user",
        parts: [
          { text: PROMPT },
          { fileData: { mimeType: "image/png", fileUri: "https://example.com/ref.png" } },
          { file_data: { mime_type: "image/png", file_uri: "https://example.com/ref2.png" } },
        ],
      }],
    }, false);

    expect(openaiBody.messages[0].content).toEqual([
      { type: "text", text: PROMPT },
      { type: "image_url", image_url: { url: "https://example.com/ref.png" } },
      { type: "image_url", image_url: { url: "https://example.com/ref2.png" } },
    ]);
  });
});
