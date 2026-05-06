import { describe, expect, test } from "vitest";
import { compile } from "@vgpu/wgsl";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3", () => {
  test("8: namespace member substitutes", async () => {
    const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
      "/main.wgsl": `import * as palette from "./palette.wgsl";
@fragment fn main() -> @location(0) vec4f { return palette.color(); }`,
      "/palette.wgsl": "export fn color() -> vec4f { return vec4f(1.0); }",
    } });
    expect(resolved.wgsl).toContain("return _vgsl_");
    expect(resolved.wgsl).not.toContain("palette.color");
  });

  test("9: namespace value error", async () => {
    await expect(resolveShader({ entry: "/main.wgsl", validate: false, modules: {
      "/main.wgsl": `import * as palette from "./palette.wgsl";
fn f() { let x = palette; }`,
      "/palette.wgsl": "export const color = 1;",
    } })).rejects.toMatchObject({ code: "VGPU-WGSL-NS-NOTVALUE" });
  });

  test("16: diamond emits once", async () => {
    const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
      "/main.wgsl": `import { a } from "./a.wgsl";
import { b } from "./b.wgsl";
fn main() { a(); b(); }`,
      "/a.wgsl": `import { c } from "./c.wgsl";
export fn a() { c(); }`,
      "/b.wgsl": `import { c } from "./c.wgsl";
export fn b() { c(); }`,
      "/c.wgsl": "export fn c() {}",
    } });
    expect(resolved.wgsl.match(/vgsl-module: \/c\.wgsl/g)).toHaveLength(1);
  });

  test("23: word boundaries", async () => {
    const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
      "/main.wgsl": `import { color } from "./p.wgsl";
fn main() { let colorize = color(); }`,
      "/p.wgsl": "export fn color() -> f32 { return 1.0; }",
    } });
    expect(resolved.wgsl).toContain("colorize");
  });

  test("24: no comments", async () => {
    const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
      "/main.wgsl": `import { color } from "./p.wgsl";
// color should stay here
fn main() { color(); }`,
      "/p.wgsl": "export fn color() {}",
    } });
    expect(resolved.wgsl).toContain("// color should stay here");
  });

  test("40: raw import rejected", () => {
    expect(() => compile(`import { color } from "./p.wgsl";`)).toThrow(expect.objectContaining({ code: "VGPU-WGSL-RUNTIME-IMPORT" }));
  });

  test("62: missing package", async () => {
    await expect(resolveShader({ entry: "/main.wgsl", validate: false, modules: { "/main.wgsl": `import { x } from "missing-pkg/x";` } }))
      .rejects.toMatchObject({ code: "VGPU-WGSL-PKG-NOTFOUND" });
  });
});
