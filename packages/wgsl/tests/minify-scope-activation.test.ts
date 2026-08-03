import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { analyzeWgslScopes } from "../src/runtime/scope-walker.ts";

// Regression coverage for https://github.com/vercel-labs/vgpu/issues/251: the scope walker's
// statement-end scan counted comparison and shift operators as template brackets, so a local
// whose initializer contained `<`, `<=`, `>=` or `<<` activated its scope entry too late. Every
// reference between the declaration's own `;` and the overshoot point failed to resolve, which
// either left the original identifier dangling in the minified output (mode 1) or bound the
// reference to an outer same-named declaration (mode 2, a silent miscompile).

const wrapHelper = (body: string) => `fn helper_fn(uv: vec2f) -> f32 {
${body}
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(helper_fn(uv), 0.0, 0.0, 1.0);
}
`;

async function minifiedWgsl(source: string): Promise<string> {
  const resolved = await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, minify: true, validate: false });
  return resolved.wgsl;
}

test("minify does not leave a dangling reference to a local with a comparison initializer", async () => {
  const wgsl = await minifiedWgsl(wrapHelper("  let flag = uv.x >= 0.0 && uv.x <= 1.0;\n  if (!flag) { return 0.0; }\n  return 1.0;"));

  expect(wgsl).not.toMatch(/\bflag\b/);
});

// Same 16 shapes as the external probe matrix for #251: 6 prefix-operator rows (the shapes the
// issue reporter blamed) plus 10 comparison/shift rows (the real trigger).
const matrix: [string, string][] = [
  ["! with no comparison in init", "let flag = true; if (!flag) { return 0.0; } return 1.0;"],
  ["! with parens, no comparison", "let flag = true; if ((!flag)) { return 0.0; } return 1.0;"],
  ["&& ! with no comparison", "let flag = true; let both = true && !flag; return select(0.0, 1.0, both);"],
  ["unary - with no comparison", "let flag = uv.x; return -flag;"],
  ["unary ~ with no comparison", "var flag = 1u; return f32(~flag);"],
  ["address-of and dereference", "var flag = 1.0; let ptr_to = &flag; return *ptr_to;"],
  ["single < with a plain reference", "let flag = uv.x < 1.0; if (flag) { return 0.0; } return 1.0;"],
  ["single < with a negated reference", "let flag = uv.x < 1.0; if (!flag) { return 0.0; } return 1.0;"],
  ["single > with a plain reference", "let flag = uv.x > 1.0; if (flag) { return 0.0; } return 1.0;"],
  [">= then <=", "let flag = uv.x >= 0.0 && uv.x <= 1.0; if (!flag) { return 0.0; } return 1.0;"],
  ["<= then >=", "let flag = uv.x <= 1.0 && uv.x >= 0.0; if (!flag) { return 0.0; } return 1.0;"],
  ["balanced < then >", "let flag = uv.x < 1.0 && uv.y > 0.0; if (!flag) { return 0.0; } return 1.0;"],
  ["no comparison at all", "let flag = true; if (!flag) { return 0.0; } return 1.0;"],
  ["< inside parentheses", "let flag = (uv.x < 1.0); if (!flag) { return 0.0; } return 1.0;"],
  ["var instead of let with <", "var flag = uv.x < 1.0; if (!flag) { return 0.0; } return 1.0;"],
  ["left shift <<", "var flag = 1u << 2u; return f32(flag);"],
];

test.each(matrix)("minify renames every local reference consistently (%s)", async (_label, body) => {
  const wgsl = await minifiedWgsl(wrapHelper(`  ${body}`));

  expect(wgsl).not.toMatch(/\bflag\b/);
});

test("minify keeps a shadowing local's reference bound to the inner declaration", async () => {
  const source = `@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var shade = 10.0;
  if (uv.x > 0.0) {
    var shade = select(0.0, 1.0, uv.y < 0.5);
    return vec4f(shade, 0.0, 0.0, 1.0);
  }
  return vec4f(shade, 0.0, 0.0, 1.0);
}
`;
  const wgsl = await minifiedWgsl(source);

  // Textual check: the name returned inside the `if` block must be the name declared inside it.
  const shadowed = /var\s+([A-Za-z_]\w*)\s*=\s*select\([^)]*\)\s*;\s*return\s+vec4f\(\s*([A-Za-z_]\w*)\s*,/.exec(wgsl);
  expect(shadowed, `no inner declaration/return pair found in:\n${wgsl}`).not.toBeNull();
  expect(shadowed![2]).toBe(shadowed![1]);

  // Structural check on the emitted WGSL: after the inner declaration the next resolved
  // reference is to the inner declaration, and the trailing `return` reads the outer one.
  const analysis = analyzeWgslScopes(wgsl);
  const locals = analysis.declarations.filter((decl) => decl.kind === "var").sort((a, b) => a.tokenIndex - b.tokenIndex);
  expect(locals).toHaveLength(2);
  const [outer, inner] = locals as [typeof locals[number], typeof locals[number]];
  const trailing = analysis.references.filter((ref) => ref.declarationId === inner.id || ref.declarationId === outer.id).map((ref) => ref.declarationId);

  expect(trailing).toEqual([inner.id, outer.id]);
});

test("minify output for comparison initializers is stable across runs", async () => {
  const source = wrapHelper("  let flag = uv.x < 1.0 && uv.y >= 0.0;\n  if (!flag) { return 0.0; }\n  return 1.0;");

  expect(await minifiedWgsl(source)).toBe(await minifiedWgsl(source));
});
