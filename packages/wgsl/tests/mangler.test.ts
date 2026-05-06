import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { assertNoMangleCollisions, hash8 } from "../src/runtime/mangler.ts";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("strings are not substituted", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { color } from './p.wgsl'; fn main(){ let s = 'color'; color(); }", "/p.wgsl": "export fn color(){}" }, validate: false })).wgsl).toContain("'color'"));
test("locals shadow module imports", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { foo } from './p.wgsl'; fn main(){ let foo = 1; let y = foo; }", "/p.wgsl": "export fn foo(){}" }, validate: false })).wgsl).toContain("let y = foo"));
test("same export names mangle distinctly", async () => { const out = (await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x as a } from './a.wgsl'; import { x as b } from './b.wgsl'; fn main(){a();b();}", "/a.wgsl": "export fn x(){}", "/b.wgsl": "export fn x(){}" }, validate: false })).wgsl; expect(new Set(out.match(/_vgsl_[0-9a-f]{8}__x/g))).toHaveProperty("size", 2); });
test("member access is not mangled", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { foo } from './p.wgsl'; fn main(){ x.foo = foo(); }", "/p.wgsl": "export fn foo() -> f32 {return 1.0;}" }, validate: false })).wgsl).toContain("x.foo"));
test("namespace member uses definition module hash", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import * as math from './p.wgsl'; fn main(){math.foo();}", "/p.wgsl": "export fn foo(){}" }, validate: false })).wgsl).toMatch(/_vgsl_[0-9a-f]{8}__foo/));
test("collision fixture throws", () => {
  let thrown: Error | undefined;
  try { assertNoMangleCollisions(["/collision/29126.wgsl", "/collision/49335.wgsl"]); } catch (error) { thrown = error as Error; }
  expect(thrown).toBeDefined();
  expect(thrown!.message).toMatch(/VGPU-WGSL-MANGLE-COLLISION/);
  expect(thrown!.message).toContain("/collision/29126.wgsl");
  expect(thrown!.message).toContain("/collision/49335.wgsl");
  const hashes = [...thrown!.message.matchAll(/[0-9a-f]{16}/g)].map((match) => match[0]);
  expect(new Set(hashes).size).toBeGreaterThanOrEqual(2);
});
test("mangled names stable for canonical path", async () => {
  expect(hash8("/project/shaders/palette.wgsl")).toBe("66db19c4");
  const opts = { entry: "/main.wgsl", validate: false, modules: { "/main.wgsl": "import { color } from './palette.wgsl'; @fragment fn main() -> @location(0) vec4f { return color(); }", "/palette.wgsl": "export fn color() -> vec4f { return vec4f(1.0); }" } };
  const first = await resolveShader(opts), second = await resolveShader({ ...opts });
  expect(first.wgsl.match(/_vgsl_[0-9a-f]{8}__color/g)?.[0]).toBe(second.wgsl.match(/_vgsl_[0-9a-f]{8}__color/g)?.[0]);
  expect(first.cacheKey).toEqual(second.cacheKey);
});

test("override constants are not mangled", async () => {
  const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": "override SAMPLES: u32 = 4u;\n@compute @workgroup_size(1) fn main() { let x = SAMPLES; }",
  } });
  const overrideLines = resolved.wgsl.split("\n").filter((line) => line.includes("override"));
  expect(overrideLines.every((line) => !line.includes("_vgsl_"))).toBe(true);
});
test("namespace member substitutes", async () => {
  const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": `import * as palette from "./palette.wgsl";
@fragment fn main() -> @location(0) vec4f { return palette.color(); }`,
    "/palette.wgsl": "export fn color() -> vec4f { return vec4f(1.0); }",
  } });
  expect(resolved.wgsl).toContain("return _vgsl_");
  expect(resolved.wgsl).not.toContain("palette.color");
});
test("word boundaries", async () => {
  const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": `import { color } from "./p.wgsl";
fn main() { let colorize = color(); }`,
    "/p.wgsl": "export fn color() -> f32 { return 1.0; }",
  } });
  expect(resolved.wgsl).toContain("colorize");
});
test("no comments", async () => {
  const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": `import { color } from "./p.wgsl";
// color should stay here
fn main() { color(); }`,
    "/p.wgsl": "export fn color() {}",
  } });
  expect(resolved.wgsl).toContain("// color should stay here");
});
test("enable argument is not substituted", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { f16 } from './p.wgsl'; enable f16; fn main(){f16();}", "/p.wgsl": "export fn f16(){}" }, validate: false })).wgsl).toContain("enable f16;"));
test("requires argument is not substituted", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { subgroup_uniform_control_flow } from './p.wgsl'; requires subgroup_uniform_control_flow; fn main(){subgroup_uniform_control_flow();}", "/p.wgsl": "export fn subgroup_uniform_control_flow(){}" }, validate: false })).wgsl).toContain("requires subgroup_uniform_control_flow;"));
test("struct field declaration not substituted", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { foo } from './p.wgsl'; struct S { foo: f32 } fn main(){foo();}", "/p.wgsl": "export fn foo() -> f32 {return 1.0;}" }, validate: false })).wgsl).toContain("foo: f32"));
test("function parameter declaration not substituted", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { foo } from './p.wgsl'; fn f(foo: f32){ let x = foo; }", "/p.wgsl": "export fn foo() -> f32 {return 1.0;}" }, validate: false })).wgsl).toContain("let x = foo"));
test("for-loop local shadows", async () => expect((await shadows("for (var i = 0u; i < 2u; i = i + 1u) {}", "i")).wgsl).toContain("i = i + 1u"));
test("loop local shadows", async () => expect((await shadows("loop { var x = 0u; let y = x; break; }", "x")).wgsl).toContain("let y = x"));
test("switch case local shadows", async () => expect((await shadows("switch (0u) { case 0u: { let bar = 1u; let y = bar; } default: {} }", "bar")).wgsl).toContain("let y = bar"));
test("function parameter shadows", async () => expect((await shadows("fn f(foo: u32){ let y = foo; }", "foo")).wgsl).toContain("let y = foo"));
test("entry point names are not mangled", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).wgsl).toContain("fn main("));
test("original entry-point appears verbatim", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).wgsl.includes("fn main(")).toBe(true));
test("override name appears verbatim", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "override SAMPLES: u32 = 4u;" }, validate: false })).wgsl).toContain("override SAMPLES"));
test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("entry point main works and mangled fails", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const shader = await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false });
  expect(shader.reflection.entryPoints[0]).toMatchObject({ name: "main", mangledName: "main" });
  expect(() => device.gpu.createComputePipeline({ layout: "auto", compute: { module: device.gpu.createShaderModule({ code: shader.wgsl }), entryPoint: "main" } })).not.toThrow();
  device.gpu.pushErrorScope("validation");
  device.gpu.createComputePipeline({ layout: "auto", compute: { module: device.gpu.createShaderModule({ code: shader.wgsl }), entryPoint: "_vgsl_deadbeef__main" } });
  expect(await device.gpu.popErrorScope()).toBeTruthy();
  device.destroy();
});
test("attribute align preserved while value align substituted", async () => {
  const out = (await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { align } from './a.wgsl'; struct S { @align(16) x: u32 } fn main(){align();}", "/a.wgsl": "export fn align(){}" }, validate: false })).wgsl;
  expect(out).toContain("@align(16)");
  expect(out).toContain("_vgsl_");
});

async function shadows(body: string, name: string) { return resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": `import { ${name} } from './p.wgsl'; ${body.startsWith("fn") ? body : `fn f(){ ${body} }`}`, "/p.wgsl": `export fn ${name}(){}` }, validate: false }); }
