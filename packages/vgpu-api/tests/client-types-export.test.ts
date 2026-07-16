import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("client export intentionally points to ambient root client.d.ts", async () => {
  const pkg = JSON.parse(await readFile("packages/vgpu-api/package.json", "utf8")) as { exports: Record<string, { types: string }> };
  const clientTypes = await readFile("packages/vgpu-api/client.d.ts", "utf8");

  expect(pkg.exports["./client"]?.types).toBe("./client.d.ts");
  expect(clientTypes).toContain('declare module "*.wgsl"');
  expect(clientTypes).toContain('declare module "vgpu/client"');
});
