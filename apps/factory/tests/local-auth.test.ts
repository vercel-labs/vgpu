import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteHandlerArgs } from "eve/channels";
import channel from "../agent/channels/eve.ts";
const TOKEN = "ab".repeat(32);

function routeArgs(): RouteHandlerArgs {
  return {
    send: vi.fn(async () => ({
      id: "session-test",
      continuationToken: "eve:test",
      cancel: async () => ({ status: "no_active_turn" as const }),
      getEventStream: async () => new ReadableStream(),
      getStreamTailIndex: async () => -1,
    })),
    resolveActiveSession: vi.fn(),
    cancel: vi.fn(),
    clear: vi.fn(),
    compact: vi.fn(),
    reset: vi.fn(),
    getSession: vi.fn(),
    receive: vi.fn(),
    params: { sessionId: "session-test" },
    waitUntil: vi.fn(),
    requestIp: "127.0.0.1",
  };
}

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:43210/eve/v1/session", {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      origin: "https://attacker.example",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "cross-site",
      ...headers,
    },
    body: JSON.stringify({ message: "A synthetic local authentication test." }),
  });
}

function createSession(request: Request, args: RouteHandlerArgs) {
  const route = channel.routes.find(
    (entry) => entry.method === "POST" && entry.path === "/eve/v1/session"
  );
  if (!route || route.method === "WEBSOCKET") {
    throw new Error("Missing Eve create-session HTTP route.");
  }
  return route.handler(request, args);
}

afterEach(() => vi.unstubAllEnvs());

describe("factory local HTTP authentication", () => {
  it("rejects a cross-origin text/plain session without the runner token", async () => {
    vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", TOKEN);
    const args = routeArgs();
    const response = await createSession(createRequest(), args);
    expect(response.status).toBe(401);
    expect(args.send).not.toHaveBeenCalled();
  });

  it("accepts the runner bearer without copying it into session metadata", async () => {
    vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", TOKEN);
    const args = routeArgs();
    const response = await createSession(
      createRequest({ authorization: `Bearer ${TOKEN}` }),
      args
    );
    expect(response.status).toBe(202);
    expect(args.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(args.send).mock.calls)).not.toContain(
      TOKEN
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).not.toContain(TOKEN);
  });

  it.each([
    [undefined, TOKEN],
    ["", TOKEN],
    ["short", "short"],
    ["ab".repeat(31), "ab".repeat(31)],
    ["gg".repeat(32), "gg".repeat(32)],
    [`${TOKEN}\n`, TOKEN],
    [TOKEN, "cd".repeat(32)],
    [TOKEN, `${TOKEN}extra`],
    [TOKEN, "ab".repeat(31)],
  ])(
    "fails closed for invalid or mismatched credentials (%#)",
    async (expected, supplied) => {
      vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", expected);
      const args = routeArgs();
      const response = await createSession(
        createRequest({ authorization: `Bearer ${supplied}`, origin: "null" }),
        args
      );
      expect(response.status).toBe(401);
      expect(args.send).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "unauthorized",
      });
    }
  );

  it("does not fall back to loopback or Vercel development authentication", async () => {
    vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", undefined);
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "development");
    const args = routeArgs();
    const response = await createSession(
      createRequest({
        origin: "null",
        authorization: "Bearer synthetic-oidc-token",
      }),
      args
    );
    expect(response.status).toBe(401);
    expect(args.send).not.toHaveBeenCalled();
  });

  it("reads the token at request time and revokes the previous token", async () => {
    vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", TOKEN);
    expect(
      (
        await createSession(
          createRequest({ authorization: `Bearer ${TOKEN}` }),
          routeArgs()
        )
      ).status
    ).toBe(202);
    const replacement = "cd".repeat(32);
    vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", replacement);
    expect(
      (
        await createSession(
          createRequest({ authorization: `Bearer ${TOKEN}` }),
          routeArgs()
        )
      ).status
    ).toBe(401);
    expect(
      (
        await createSession(
          createRequest({ authorization: `Bearer ${replacement}` }),
          routeArgs()
        )
      ).status
    ).toBe(202);
  });

  it("requires the runner token for every authored info/session route", async () => {
    vi.stubEnv("VGPU_FACTORY_LOCAL_TOKEN", TOKEN);
    expect(channel.routes.length).toBe(8);
    expect(channel.cors).toBeUndefined();
    for (const route of channel.routes) {
      if (route.method === "WEBSOCKET")
        throw new Error("Unexpected WebSocket route.");
      const args = routeArgs();
      const response = await route.handler(
        new Request(`http://127.0.0.1:43210${route.path}`, {
          method: route.method,
        }),
        args
      );
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(args.send).not.toHaveBeenCalled();
      expect(args.getSession).not.toHaveBeenCalled();
      expect(args.reset).not.toHaveBeenCalled();
      expect(args.clear).not.toHaveBeenCalled();
      expect(args.compact).not.toHaveBeenCalled();
    }
  });
});
