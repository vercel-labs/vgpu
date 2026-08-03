import { expect, test } from "vitest";
import { applyIdentifierMinifyWgsl, buildIdentifierReplacements } from "../src/runtime/identifier-minify.ts";
import { analyzeWgslScopes, type ScopeAnalysis } from "../src/runtime/scope-walker.ts";

// Defense in depth for vgpu#251: the identifier renamer must not trust the scope analysis blindly.
// Before renaming a local it verifies that every identifier token in the same function spelled the
// same way is one of that declaration's own recorded occurrences. A scope-analysis bug therefore
// degrades to a missed optimization instead of dangling or misattributed identifiers.

const comparisonInitializer = "fn helper_fn(uv: vec2f) -> f32 { let flag = uv.x < 1.0; if (flag) { return 0.0; } return 1.0; }";

test("identifier minify leaves a local unrenamed when the scope analysis loses one of its references", () => {
  const analysis = analyzeWgslScopes(comparisonInitializer);
  const declaration = analysis.declarations.find((decl) => decl.name === "flag");
  const references = analysis.references.filter((ref) => ref.declarationId === declaration?.id);
  expect(declaration).toBeDefined();
  expect(references).toHaveLength(1);

  // Reproduce the pre-fix scope walker's observable failure without reintroducing the bug: drop the
  // reference the overshooting statement scan used to miss.
  const sabotaged: ScopeAnalysis = { ...analysis, references: analysis.references.filter((ref) => ref !== references[0]) };
  const replacements = buildIdentifierReplacements(sabotaged);

  expect(replacements.has(declaration!.tokenIndex)).toBe(false);
  expect(replacements.has(references[0]!.tokenIndex)).toBe(false);
  // Unaffected locals in the same function are still renamed.
  expect(replacements.has(analysis.declarations.find((decl) => decl.name === "uv")!.tokenIndex)).toBe(true);
});

test("identifier minify still renames locals whose occurrences are all accounted for", () => {
  const analysis = analyzeWgslScopes(comparisonInitializer);
  const declaration = analysis.declarations.find((decl) => decl.name === "flag");
  const replacements = buildIdentifierReplacements(analysis);

  expect(replacements.get(declaration!.tokenIndex)).toBeTypeOf("string");
  for (const ref of analysis.references.filter((item) => item.declarationId === declaration?.id)) {
    expect(replacements.get(ref.tokenIndex)).toBe(replacements.get(declaration!.tokenIndex));
  }
});

// Accepted trade-off: the guard is a literal same-text check, so a name legitimately reused by two
// disjoint sibling blocks is also left alone. That costs a few bytes of minification and never
// costs correctness.
test("identifier minify skips renaming a local name reused by a sibling block scope", () => {
  const result = applyIdentifierMinifyWgsl("fn f(seed: f32) -> f32 { var total = 0.0; { let x = seed; total = total + x; } { let x = seed * 2.0; total = total + x; } return total; }");
  const analysis = analyzeWgslScopes(result.wgsl);
  const reused = analysis.declarations.filter((decl) => decl.name === "x");

  expect(result.wgsl).toContain("let x=");
  expect(reused).toHaveLength(2);
  expect(analysis.references.filter((ref) => ref.declarationId === reused[0]?.id)).toHaveLength(1);
  expect(analysis.references.filter((ref) => ref.declarationId === reused[1]?.id)).toHaveLength(1);
  // The skip is per name, not per function: every unambiguous local is still shortened.
  expect(result.wgsl).not.toContain("seed");
  expect(result.wgsl).not.toContain("total");
});

test("identifier minify skips renaming a shadowed local pair instead of risking misattribution", () => {
  const result = applyIdentifierMinifyWgsl("fn f(v: f32) -> f32 { var x = 10.0; if (v > 0.0) { var x = select(0.0, 1.0, v < 0.5); return x; } return x; }");

  expect(result.wgsl).toContain("var x=10.0");
  expect(result.wgsl).toContain("var x=select(");
  expect(result.wgsl).toMatch(/fn f\(a:f32\)/);
});
