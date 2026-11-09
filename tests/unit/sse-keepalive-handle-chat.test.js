import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const req = (body) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("handleChat keepalive", () => {
  it("leaves non-stream requests as plain JSON with their real status", async () => {
    const res = await handleChat(req({ stream: false }), null, { keepalive: true });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("leaves stream requests alone when keepalive is not requested", async () => {
    const res = await handleChat(req({ stream: true }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("commits SSE headers for stream:true and delivers the error in-stream", async () => {
    const res = await handleChat(req({ stream: true }), null, { keepalive: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text.startsWith(": ping\n\n")).toBe(true);
    expect(text).toContain("Missing model");
  });
});
