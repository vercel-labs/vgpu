import { expect, test } from "vitest";
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
