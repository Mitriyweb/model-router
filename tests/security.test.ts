import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { startServer } from "../src/server";

describe("security defaults", () => {
  const originalToken = config.authToken;
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeAll(() => {
    config.authToken = "secret-reset-token";
    server = startServer(0);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    config.authToken = originalToken;
    server.stop();
  });

  test("reset endpoints require the configured token", async () => {
    const unauthenticated = await fetch(`${baseUrl}/reset`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "unauthorized" });
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

    const badToken = await fetch(`${baseUrl}/reset-state`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(badToken.status).toBe(401);

    const bearer = await fetch(`${baseUrl}/v1/reset`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-reset-token" },
    });
    expect(bearer.status).toBe(200);

    const customHeader = await fetch(`${baseUrl}/reset`, {
      method: "DELETE",
      headers: { "x-router-auth-token": "secret-reset-token" },
    });
    expect(customHeader.status).toBe(200);
  });

  test("health and status stay public", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/status`)).status).toBe(200);
  });
});
