import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { applyIdentifierMinifyWgsl, assertNoDanglingLocalReferences, buildIdentifierReplacements } from "../src/runtime/identifier-minify.ts";
import { analyzeWgslScopes, type ScopeAnalysis } from "../src/runtime/scope-walker.ts";

// Always-on self-check for vgpu#251: before emitting, identifier-safe minification asserts that no
// token still spelled like a local it renamed survives inside that local's function. The check is
// driven by the replacements map rather than by re-scanning the printed WGSL, because unresolved
// builtin calls (`sin`, `select`, `vec4f`) carry the same "unknown" preserve reason as a genuinely
// dangling local and a text-level scan could not tell them apart.

const comparisonInitializer = "fn helper_fn(uv: vec2f) -> f32 { let flag = uv.x < 1.0; if (flag) { return 0.0; } return 1.0; }";

test("self-check rejects a replacement map that would orphan a local reference", () => {
  const analysis = analyzeWgslScopes(comparisonInitializer);
  const declaration = analysis.declarations.find((decl) => decl.name === "flag")!;
  // Rename the declaration but not its reference: exactly the output the pre-fix scope walker
  // produced, with the reference it lost still spelled `flag`.
  const orphaning = new Map<number, string>([[declaration.tokenIndex, "z"]]);

  expect(() => assertNoDanglingLocalReferences(analysis, orphaning)).toThrow(expect.objectContaining({ code: "VGPU-WGSL-MINIFY-DANGLING-IDENT" }));
  expect(() => assertNoDanglingLocalReferences(analysis, orphaning)).toThrow(/dangling reference to 'flag'/);
});

test("self-check accepts the replacement map the renamer actually produces", () => {
  const analysis = analyzeWgslScopes(comparisonInitializer);

  expect(() => assertNoDanglingLocalReferences(analysis, buildIdentifierReplacements(analysis))).not.toThrow();
});

test("self-check ignores locals the renamer left alone", () => {
  const analysis = analyzeWgslScopes("fn f(seed: f32) -> f32 { { let x = seed; return x; } { let x = seed * 2.0; return x; } }");

  // Both `x` declarations are skipped by the per-declaration guard, so their surviving tokens are
  // not dangling and must not trip the assertion.
  expect(() => assertNoDanglingLocalReferences(analysis, buildIdentifierReplacements(analysis))).not.toThrow();
});

test("self-check does not fire on a builtin-heavy shader with comparison initializers", async () => {
  const source = `@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let edge = uv.x < 0.5;
  let wave = sin(uv.y * 6.28318);
  let strength = clamp(dot(uv, uv), 0.0, 1.0);
  let shade = select(wave, strength, edge);
  let blended = mix(shade, 1.0 - shade, f32(uv.y >= 0.5));
  return vec4f(blended, shade, strength, 1.0);
}
`;
  const resolved = await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, minify: true, validate: false });

  // Builtins survive verbatim; every local is renamed; nothing throws.
  for (const builtin of ["sin", "clamp", "dot", "select", "mix", "vec4f", "f32"]) expect(resolved.wgsl).toContain(builtin);
  for (const local of ["edge", "wave", "strength", "shade", "blended"]) expect(resolved.wgsl).not.toMatch(new RegExp(`\\b${local}\\b`));
  expect(() => applyIdentifierMinifyWgsl(source)).not.toThrow();
});

test("self-check is inert when the scope walker falls back for the whole module", async () => {
  const source = "let localish = 1u;\n@compute @workgroup_size(1) fn main() { let value = 1u < 2u; let other = value; }\n";
  const analysis = analyzeWgslScopes(source);
  const result = applyIdentifierMinifyWgsl(source);

  expect(analysis.fallback.wholeModule).toBe(true);
  expect(result.replacements.size).toBe(0);
  expect(result.wgsl).toContain("localish");
  expect(result.wgsl).toContain("value");
  await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, minify: true, validate: false })).resolves.toBeDefined();
});

test("self-check surfaces a dangling identifier through the public minify entry point", () => {
  const analysis = analyzeWgslScopes(comparisonInitializer);
  const declaration = analysis.declarations.find((decl) => decl.name === "flag")!;
  const reference = analysis.references.find((ref) => ref.declarationId === declaration.id)!;
  // A scope analysis that lost a reference AND a renamer that ignored the per-declaration guard is
  // the combination the self-check exists to stop; assert it reports the function by name.
  const sabotaged: ScopeAnalysis = { ...analysis, references: analysis.references.filter((ref) => ref !== reference) };

  expect(() => assertNoDanglingLocalReferences(sabotaged, new Map([[declaration.tokenIndex, "z"]]))).toThrow(/in function 'helper_fn'/);
});
