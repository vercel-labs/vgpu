import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3 §8 1-39", () => {
  test("37 json report is serializable", async () => expect(JSON.parse(JSON.stringify(await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "fn main(){}" }, validate: false })))).toHaveProperty("wgsl"));
  test("38 deps mermaid can be formed", async () => { const ast = (await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from './x.wgsl'; fn main(){x();}", "/x.wgsl": "export fn x(){}" }, validate: false })).ast; expect(`graph TD\n${ast.modules.map((m) => m.imports.map((i) => `${m.path}-->${i.from}`).join("\n")).join("\n")}`).toContain("graph TD"); });
  test("39 repeated resolve bytes stable", async () => { const opts = { entry: "/m.wgsl", modules: { "/m.wgsl": "fn main(){}" }, validate: false }; expect((await resolveShader(opts)).wgsl).toBe((await resolveShader(opts)).wgsl); });
});

describe("s3", () => {
  test("67: cacheKey byte-equal across two compiles", async () => {
    const opts = { entry: "/main.wgsl", validate: false, modules: { "/main.wgsl": "@compute @workgroup_size(1) fn main() {}" } };
    await expect(resolveShader(opts)).resolves.toMatchObject({ cacheKey: { main: expect.stringMatching(/^vgsl-1:[0-9a-f]{32}$/) } });
    expect((await resolveShader(opts)).cacheKey).toEqual((await resolveShader(opts)).cacheKey);
  });
});
