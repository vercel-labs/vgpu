import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("json report is serializable", async () => expect(JSON.parse(JSON.stringify(await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "fn main(){}" }, validate: false })))).toHaveProperty("wgsl"));
test("deps mermaid can be formed", async () => { const ast = (await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from './x.wgsl'; fn main(){x();}", "/x.wgsl": "export fn x(){}" }, validate: false })).ast; expect(`graph TD\n${ast.modules.map((m) => m.imports.map((i) => `${m.path}-->${i.from}`).join("\n")).join("\n")}`).toContain("graph TD"); });
test("repeated resolve bytes stable", async () => { const opts = { entry: "/m.wgsl", modules: { "/m.wgsl": "fn main(){}" }, validate: false }; expect((await resolveShader(opts)).wgsl).toBe((await resolveShader(opts)).wgsl); });
test("cacheKey byte-equal across two compiles", async () => {
  const opts = { entry: "/main.wgsl", validate: false, modules: { "/main.wgsl": "@compute @workgroup_size(1) fn main() {}" } };
  await expect(resolveShader(opts)).resolves.toMatchObject({ cacheKey: { main: expect.stringMatching(/^vgsl-1:[0-9a-f]{32}$/) } });
  expect((await resolveShader(opts)).cacheKey).toEqual((await resolveShader(opts)).cacheKey);
});
test("cacheKey regex and repeat equality", async () => { const r = await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false }); expect(r.cacheKey.main).toMatch(/^vgsl-1:[0-9a-f]{32}$/); expect(r.cacheKey).toEqual((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).cacheKey); });
test("comments ignored by cacheKey", async () => expect((await ck("// a\nfn main(){}"))).toEqual(await ck("// b\nfn main(){}")));
test("whitespace ignored by cacheKey", async () => expect(await ck("fn main(){ return; }")).toEqual(await ck("fn   main() {\n return;\n}")));
test("semantic body change differs", async () => expect(await ck("fn main(){ let x = 1; }")).not.toEqual(await ck("fn main(){ let x = 2; }")));
test("mangle spelling ignored", async () => { const source = "import { x } from './a.wgsl'; fn main(){x();}"; const a = await resolveShader({ entry: "/tmp/a/proj/m.wgsl", rootDir: "/tmp/a/proj", modules: { "/tmp/a/proj/m.wgsl": source, "/tmp/a/proj/a.wgsl": "export fn x(){}" }, validate: false }); const b = await resolveShader({ entry: "/tmp/b/proj/m.wgsl", rootDir: "/tmp/b/proj", modules: { "/tmp/b/proj/m.wgsl": source, "/tmp/b/proj/a.wgsl": "export fn x(){}" }, validate: false }); expect(a.wgsl).not.toBe(b.wgsl); expect(a.cacheKey).toEqual(b.cacheKey); });
test("cross-machine deterministic snapshot", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).cacheKey.main).toBe("vgsl-1:d4b13650ab62922eb74c26a5a098c79d"));

async function ck(source: string) { return (await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, validate: false })).cacheKey; }
