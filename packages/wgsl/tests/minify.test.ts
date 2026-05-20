import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { minifyWgsl } from "../src/runtime/minify.ts";

test("minify strips line comments", () => {
  expect(minifyWgsl("// header\nfn main() { return; } // tail\n")).toBe("fn main(){return;}");
});

test("minify strips nested block comments", () => {
  expect(minifyWgsl("fn main() { /* outer /* nested */ done */ return; }")).toBe("fn main(){return;}");
});

test("minify collapses whitespace conservatively", () => {
  expect(minifyWgsl("@compute   @workgroup_size(1)\nfn   main ( )  { \n let   x :  u32 = 1u ;\n}")).toBe("@compute @workgroup_size(1) fn main(){let x:u32=1u;}");
});

test("minify preserves token boundaries around identifiers and numbers", () => {
  const minified = minifyWgsl("let ab = a /* comment */ b; let n = 1 /* comment */ 2; let e = 1e /* comment */ + 2; let suff = 1 /* comment */ u;");
  expect(minified).toBe("let ab=a b;let n=1 2;let e=1e +2;let suff=1 u;");
});

test("minify preserves hex-float exponent token boundaries across comments and whitespace", () => {
  // Keep a separator after hex-float exponent markers so comment/space removal cannot
  // merge tokens into a different literal such as 0x1p+3 or 0x1.8p-2.
  const minified = minifyWgsl("let hp = 0x1p /* comment */ + 3; let hn = 0x1.8P\n - 2;");
  expect(minified).toBe("let hp=0x1p +3;let hn=0x1.8P -2;");
});

test("minify preserves token boundaries around attributes templates and operators", () => {
  const minified = minifyWgsl("@compute /* comment */ @workgroup_size(1) fn main(){ var p: ptr<function, array<vec4<f32>, 4> >; let y = x - -z; if (a & & b) {} }");
  expect(minified).toContain("@compute @workgroup_size(1) fn main()");
  expect(minified).toContain("array<vec4<f32>,4> >");
  expect(minified).toContain("x- -z");
  expect(minified).toContain("a& &b");
});

test("minify does not rename entry uniform or resource identifiers", () => {
  const minified = minifyWgsl("@group(0) @binding(0) var<uniform> Camera: CameraUniform; @group(0) @binding(1) var resourceTexture: texture_2d<f32>; @compute @workgroup_size(1) fn entry_main(){ resourceName(); }");
  expect(minified).toContain("Camera:CameraUniform");
  expect(minified).toContain("resourceTexture:texture_2d<f32>");
  expect(minified).toContain("fn entry_main()");
  expect(minified).toContain("resourceName()");
});

test("minify throws a deterministic error for unterminated block comments", () => {
  expect(() => minifyWgsl("fn main(){ /* unterminated")).toThrow(expect.objectContaining({ code: "VGPU-WGSL-MINIFY-BLOCK", message: "Unterminated WGSL block comment" }));
});

test("resolveShader minify true compacts imported graph while false keeps current output", async () => {
  const opts = { entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": `import { color } from "./palette.wgsl";
// entry comment
@fragment
fn fs_main() -> @location(0) vec4f {
  return color(); // call comment
}`,
    "/palette.wgsl": `// palette comment
export fn color() -> vec4f {
  /* block comment */ return vec4f(1.0, 0.0, 0.0, 1.0);
}`,
  } };

  const current = await resolveShader(opts);
  const compact = await resolveShader({ ...opts, minify: true });

  expect(current.wgsl).toContain("// vgsl-module: /main.wgsl");
  expect(current.wgsl).toContain("// entry comment");
  expect(current.wgsl).toContain("\n");
  expect(compact.wgsl).not.toContain("//");
  expect(compact.wgsl).not.toContain("/*");
  expect(compact.wgsl).not.toContain("\n");
  expect(compact.wgsl).toMatch(/fn fs_main\(\)-> ?@location\(0\) ?vec4f\{return _vgsl_/);
});

test("resolveShader minify option does not change cache key", async () => {
  const opts = { entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": "// comment\n@compute @workgroup_size(1) fn main(){ let x = 1u; }" } };
  expect((await resolveShader({ ...opts, minify: true })).cacheKey).toEqual((await resolveShader({ ...opts, minify: false })).cacheKey);
});
