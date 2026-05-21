import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { applyIdentifierMinifyWgsl } from "../src/runtime/identifierMinify.ts";
import { minifyWgsl, normalizeMinifyOption, applyMinifyWgsl } from "../src/runtime/minify.ts";
import { scan } from "../src/runtime/scanner.ts";
import { printWgslTokens } from "../src/runtime/tokenPrinter.ts";
import { RenameAllocator } from "../src/runtime/renameAllocator.ts";
import { WGSL_ATTRIBUTE_NAMES, WGSL_BUILTIN_VALUES, WGSL_RENAME_FORBIDDEN_IDENTIFIERS } from "../src/runtime/wgslIdentifiers.ts";

test("normalizeMinifyOption maps booleans and object defaults", () => {
  expect(normalizeMinifyOption(undefined)).toEqual({ whitespace: false, identifiers: "none" });
  expect(normalizeMinifyOption(false)).toEqual({ whitespace: false, identifiers: "none" });
  expect(normalizeMinifyOption(true)).toEqual({ whitespace: true, identifiers: "safe" });
  expect(normalizeMinifyOption({})).toEqual({ whitespace: true, identifiers: "none" });
  expect(normalizeMinifyOption({ whitespace: false })).toEqual({ whitespace: false, identifiers: "none" });
  expect(normalizeMinifyOption({ identifiers: "safe" })).toEqual({ whitespace: true, identifiers: "safe" });
});

test("normalizeMinifyOption rejects unknown identifier modes", () => {
  expect(() => normalizeMinifyOption({ identifiers: "unsafe" } as never)).toThrow(expect.objectContaining({ code: "VGPU-WGSL-MINIFY-IDENTIFIERS" }));
});

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

test("minify preserves signed decimal exponent literals", () => {
  const source = "fn repro() -> bool { return 1e-8 > 0.0 && 1e+8 > 0.0 && 1E-8 > 0.0 && 1E+8 > 0.0 && 1.0e-8 > 0.0 && 1.0e+8 > 0.0 && 1.e-8 > 0.0; }";
  const expected = "fn repro()-> bool{return 1e-8>0.0&&1e+8>0.0&&1E-8>0.0&&1E+8>0.0&&1.0e-8>0.0&&1.0e+8>0.0&&1.e-8>0.0;}";
  expect(minifyWgsl(source)).toBe(expected);
  expect(applyMinifyWgsl(source, { identifiers: "none" })).toBe(expected);
  expect(applyMinifyWgsl(source, { identifiers: "safe" })).toBe(expected);
});

test("minify preserves signed hex exponent literals", () => {
  const source = "fn repro() -> bool { return 0x1p-8 > 0.0 && 0x1p+8 > 0.0 && 0x1P-8 > 0.0 && 0x1P+8 > 0.0 && 0x1.8p-2 > 0.0; }";
  const expected = "fn repro()-> bool{return 0x1p-8>0.0&&0x1p+8>0.0&&0x1P-8>0.0&&0x1P+8>0.0&&0x1.8p-2>0.0;}";
  expect(minifyWgsl(source)).toBe(expected);
  expect(applyMinifyWgsl(source, { identifiers: "none" })).toBe(expected);
  expect(applyMinifyWgsl(source, { identifiers: "safe" })).toBe(expected);
});

test("minify preserves token boundaries around attributes templates and operators", () => {
  const minified = minifyWgsl("@compute /* comment */ @workgroup_size(1) fn main(){ var p: ptr<function, array<vec4<f32>, 4> >; let y = x - -z; if (a & & b) {} }");
  expect(minified).toContain("@compute @workgroup_size(1) fn main()");
  expect(minified).toContain("array<vec4<f32>,4> >");
  expect(minified).toContain("x- -z");
  expect(minified).toContain("a& &b");
});

test("minify joins compound operators split by comments when removing comments", () => {
  expect(minifyWgsl("fn f(){ let same = x =/* c */= y; let ne = x !/* c */= y; }")).toContain("same=x==y;let ne=x!=y;");
});

test("token printer accepts per-token replacements for future identifier renaming", () => {
  const tokens = scan("fn main(){ let source_name = source_name + 1u; }");
  const replacements = new Map([[tokens.find((token) => token.text === "source_name")!, "a"]]);
  expect(printWgslTokens(tokens, { replacements })).toBe("fn main(){let a=source_name+1u;}");
});

test("WGSL identifier tables include reserved attributes builtins and predeclared names", () => {
  expect(WGSL_ATTRIBUTE_NAMES.has("workgroup_size")).toBe(true);
  expect(WGSL_BUILTIN_VALUES.has("global_invocation_id")).toBe(true);
  expect(WGSL_RENAME_FORBIDDEN_IDENTIFIERS.has("vec4f")).toBe(true);
  expect(WGSL_RENAME_FORBIDDEN_IDENTIFIERS.has("fn")).toBe(true);
});

test("minify does not rename entry uniform or resource identifiers", () => {
  const minified = minifyWgsl("@group(0) @binding(0) var<uniform> Camera: CameraUniform; @group(0) @binding(1) var resourceTexture: texture_2d<f32>; @compute @workgroup_size(1) fn entry_main(){ resourceName(); }");
  expect(minified).toContain("Camera:CameraUniform");
  expect(minified).toContain("resourceTexture:texture_2d<f32>");
  expect(minified).toContain("fn entry_main()");
  expect(minified).toContain("resourceName()");
});

test("rename allocator skips forbidden reserved and already used names", () => {
  const allocator = new RenameAllocator({ reserved: ["a", "b", "vec4f", "_"] });
  expect(allocator.allocate()).toBe("c");
  allocator.reserve("d");
  expect(allocator.allocate()).toBe("e");
});

test("identifier minify renames locals params and for-init refs", () => {
  const result = applyIdentifierMinifyWgsl("fn f(long_param: u32) -> u32 { var total_value = long_param; for (var loop_index: u32 = 0u; loop_index < 4u; loop_index = loop_index + 1u) { total_value = total_value + loop_index; } return total_value; }").wgsl;
  expect(result).toBe("fn f(a:u32)-> u32{var b=a;for(var c:u32=0u;c<4u;c=c+1u){b=b+c;}return b;}");
});

test("identifier minify handles shadowing without colliding with unrenamed names", () => {
  const result = applyIdentifierMinifyWgsl("fn f(input_value: u32) -> u32 { let outer_value = input_value; { let inner_value = outer_value; let keep_name = textureLoad; } return outer_value; }").wgsl;
  expect(result).toContain("let b=a");
  expect(result).toContain("let c=b");
  expect(result).toContain("textureLoad");
  expect(result).not.toContain("let textureLoad");
});

test("identifier minify preserves host-visible globals entry points resources overrides structs fields and types", () => {
  const source = "struct CameraUniform { value: vec4f, }; @group(0) @binding(0) var<uniform> Camera: CameraUniform; override WorkgroupSize: u32 = 1u; @compute @workgroup_size(WorkgroupSize) fn entry_main(@builtin(global_invocation_id) gid: vec3u) { var local_value: vec4f = Camera.value; }";
  const result = applyMinifyWgsl(source, true);
  expect(result).toContain("struct CameraUniform{value:vec4f,}");
  expect(result).toContain("var<uniform> Camera:CameraUniform");
  expect(result).toContain("override WorkgroupSize:u32=1u");
  expect(result).toContain("fn entry_main(@builtin(global_invocation_id) a:vec3u)");
  expect(result).toContain("Camera.value");
  expect(result).not.toContain("local_value");
});

test("identifier minify can preserve original whitespace and comments", () => {
  const source = "// lead\nfn main() {\n  /* local */ var local_value = 1u;\n  local_value = local_value + 1u; // tail\n}\n";
  expect(applyMinifyWgsl(source, { whitespace: false, identifiers: "safe" })).toBe("// lead\nfn main() {\n  /* local */ var a = 1u;\n  a = a + 1u; // tail\n}\n");
});

test("identifier minify shortens safe resolver helper functions and updates calls", () => {
  const result = applyIdentifierMinifyWgsl("fn _vgsl_deadbeef__helper(input_value: u32) -> u32 { return input_value + 1u; } fn main() { let local_value = _vgsl_deadbeef__helper(1u); }").wgsl;
  expect(result).toBe("fn a(b:u32)-> u32{return b+1u;}fn main(){let b=a(1u);}");
});

test("identifier minify leaves risky helper functions unchanged", () => {
  const source = "fn _vgsl_deadbeef__helper(v: u32) -> u32 { return v; } alias Alias = _vgsl_deadbeef__helper; fn main() { let local_value = _vgsl_deadbeef__helper(1u); }";
  const result = applyIdentifierMinifyWgsl(source);
  expect(result.skippedHelperFunctions).toEqual(["_vgsl_deadbeef__helper"]);
  expect(result.wgsl).toContain("fn _vgsl_deadbeef__helper");
  expect(result.wgsl).toContain("_vgsl_deadbeef__helper(1u)");
  expect(result.wgsl).not.toContain("local_value");
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
  expect(compact.wgsl).toMatch(/fn fs_main\(\)-> ?@location\(0\) ?vec4f\{return a\(\);}/);
  expect(compact.wgsl).toContain("fn a()-> vec4f");
});

test("resolveShader minify option does not change cache key", async () => {
  const opts = { entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": "// comment\n@compute @workgroup_size(1) fn main(){ let x = 1u; }" } };
  expect((await resolveShader({ ...opts, minify: true })).cacheKey).toEqual((await resolveShader({ ...opts, minify: false })).cacheKey);
});


test("resolveShader object-form minify compacts whitespace without identifier renaming", async () => {
  const opts = { entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": "// comment\n@compute @workgroup_size(1) fn main(){ let stable_name = 1u; }" } };
  const compact = await resolveShader({ ...opts, minify: { identifiers: "none" } });
  expect(compact.wgsl).toBe("@compute @workgroup_size(1) fn main(){let stable_name=1u;}");
  expect(compact.wgsl).toContain("stable_name");

  const unminified = await resolveShader({ ...opts, minify: { whitespace: false, identifiers: "none" } });
  expect(unminified.wgsl).toContain("// comment");
  expect(unminified.wgsl).toContain("stable_name = 1u");
});

test("resolveShader object-form minify keeps whitespace independent from identifier renaming", async () => {
  const opts = { entry: "/m.wgsl", validate: false, modules: { "/m.wgsl": "// comment\n@compute @workgroup_size(1) fn main(){\n  var local_value = 1u;\n  local_value = local_value + 1u;\n}" } };
  const result = await resolveShader({ ...opts, minify: { whitespace: false, identifiers: "safe" } });
  expect(result.wgsl).toContain("// comment");
  expect(result.wgsl).toContain("\n  var a = 1u;\n  a = a + 1u;");
  expect(result.wgsl).not.toContain("local_value");
});
