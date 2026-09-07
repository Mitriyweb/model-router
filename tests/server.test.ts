import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server";

describe("Server API Endpoints & Provider Specific Routing", () => {
  const server = startServer(0);
  const baseUrl = `http://localhost:${server.port}`;

  test("GET /v1/models returns available models list with configuration state", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);

    const modelIds = json.data.map((m: any) => m.id);
    expect(modelIds).toContain("model-router-auto");
    expect(modelIds).toContain("groq");
    expect(modelIds).toContain("cerebras");

    const autoModel = json.data.find((m: any) => m.id === "model-router-auto");
    expect(autoModel.configured).toBe(true);
  });

  test("GET /v1/providers returns providers list with details", async () => {
    const res = await fetch(`${baseUrl}/v1/providers`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);

    const providerIds = json.data.map((p: any) => p.id);
    expect(providerIds).toContain("groq");
    expect(providerIds).toContain("gemini");
    expect(providerIds).toContain("cerebras");

    const groqProvider = json.data.find((p: any) => p.id === "groq");
    expect(groqProvider.name).toBe("groq");
    expect(groqProvider).toHaveProperty("configured");
    expect(groqProvider).toHaveProperty("limits");
    expect(groqProvider).toHaveProperty("status");
  });

  test("POST /v1/providers/:provider/chat/completions returns error for unknown provider", async () => {
    const res = await fetch(`${baseUrl}/v1/providers/invalid-provider/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("Unknown provider");
  });

  test("POST /v1/providers/:provider/messages returns error for unknown provider", async () => {
    const res = await fetch(`${baseUrl}/v1/providers/invalid-provider/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unknown provider");
  });

  test("POST /v1/providers/:provider/chat/completions routes to specific provider (e.g. unconfigured provider error)", async () => {
    const res = await fetch(`${baseUrl}/v1/providers/huggingface/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    // Since huggingface is unconfigured (or fails in test env without API key), it should return 502 (all tiers exhausted)
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.type).toBe("all_tiers_exhausted");
  });

  test("x-router-provider header forces routing to specified provider", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-router-provider": "huggingface",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.type).toBe("all_tiers_exhausted");
  });
});
