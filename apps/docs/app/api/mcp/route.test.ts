import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { POST, dynamic, runtime } from "./route";

const publicPackage = JSON.parse(
  readFileSync(new URL("../../../../../packages/vgpu-api/package.json", import.meta.url), "utf8"),
);

test("the public MCP route stays on Node and applies the HTTP request gate", async () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");

  const response = await POST(new Request("https://vgpu.sh/api/mcp", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: "{}",
  }));

  expect(response.status).toBe(403);
});

test("the hosted MCP negotiates the modern protocol and identifies the public vgpu version", async () => {
  const client = new Client(
    { name: "vgpu-route-version-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL("https://vgpu.sh/api/mcp"), {
    fetch: (input, init) => POST(new Request(input, init)),
  });

  try {
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getServerVersion()?.version).toBe(publicPackage.version);
  } finally {
    await client.close().catch(() => undefined);
  }
});
