import { expect, test } from "vitest";
import { analyzeWgslScopes } from "../src/runtime/scope-walker.ts";

function decls(source: string) {
  return analyzeWgslScopes(source).declarations.map((decl) => ({ name: decl.name, kind: decl.kind, safeToRename: decl.safeToRename }));
}

function refsFor(source: string, name: string) {
  const analysis = analyzeWgslScopes(source);
  return analysis.references
    .filter((ref) => analysis.declarations[ref.declarationId]?.name === name)
    .map((ref) => analysis.tokens[ref.tokenIndex]?.text);
}

test("scope walker detects function params locals and references", () => {
  const analysis = analyzeWgslScopes("fn f(a: u32, b: vec4f) -> u32 { let x: u32 = a; var y = x + a; const z = y; return z; }");

  expect(decls("fn f(a: u32, b: vec4f) -> u32 { let x: u32 = a; var y = x + a; const z = y; return z; }")).toEqual([
    { name: "f", kind: "function", safeToRename: false },
    { name: "a", kind: "param", safeToRename: true },
    { name: "b", kind: "param", safeToRename: true },
    { name: "x", kind: "let", safeToRename: true },
    { name: "y", kind: "var", safeToRename: true },
    { name: "z", kind: "const", safeToRename: true },
  ]);
  expect(refsFor("fn f(a: u32, b: vec4f) -> u32 { let x: u32 = a; var y = x + a; const z = y; return z; }", "a")).toEqual(["a", "a"]);
  expect(analysis.fallback.wholeModule).toBe(false);
  expect(analysis.functions[0]?.skipped).toBe(false);
});

test("scope walker resolves shadowing innermost first", () => {
  const analysis = analyzeWgslScopes("fn f(a: u32) { let x = a; { let x = 2u; let y = x; } let z = x; }");
  const outer = analysis.declarations.find((decl) => decl.name === "x" && decl.kind === "let");
  const inner = analysis.declarations.findLast((decl) => decl.name === "x" && decl.kind === "let");
  const outerRefs = analysis.references.filter((ref) => ref.declarationId === outer?.id);
  const innerRefs = analysis.references.filter((ref) => ref.declarationId === inner?.id);

  expect(outer?.id).not.toBe(inner?.id);
  expect(outerRefs).toHaveLength(1);
  expect(innerRefs).toHaveLength(1);
});

test("scope walker keeps for-init locals visible through the loop body", () => {
  const analysis = analyzeWgslScopes("fn f() { for (var i: u32 = 0u; i < 4u; i = i + 1u) { let x = i; } }");
  const iDecl = analysis.declarations.find((decl) => decl.name === "i");
  const iRefs = analysis.references.filter((ref) => ref.declarationId === iDecl?.id);

  expect(iDecl).toMatchObject({ kind: "var", safeToRename: true });
  expect(iRefs).toHaveLength(4);
  expect(analysis.scopes.some((scope) => scope.kind === "for-init")).toBe(true);
  expect(analysis.functions[0]?.skipped).toBe(false);
});

test("scope walker preserves attributes members type positions directives structs and globals", () => {
  const source = "enable f16; diagnostic(off, derivative_uniformity); struct S { field: vec3f, other: u32, }; @group(0) @binding(0) var<uniform> Camera: S; @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) { var local: S; let value = local.field; }";
  const analysis = analyzeWgslScopes(source);
  const preserved = (text: string, reason: string) => analysis.preservedTokens.some((item) => analysis.tokens[item.tokenIndex]?.text === text && item.reason === reason);

  expect(preserved("f16", "directive")).toBe(true);
  expect(preserved("field", "struct")).toBe(true);
  expect(preserved("Camera", "global")).toBe(true);
  expect(preserved("uniform", "type")).toBe(true);
  expect(preserved("compute", "attribute")).toBe(true);
  expect(preserved("global_invocation_id", "attribute")).toBe(true);
  expect(preserved("S", "type")).toBe(true);
  expect(analysis.references.some((ref) => analysis.tokens[ref.tokenIndex]?.text === "field")).toBe(false);
});

test("scope walker classifies safe post-mangle private helper declarations and references", () => {
  const analysis = analyzeWgslScopes("fn _vgsl_deadbeef__helper(v: u32) -> u32 { return v; } fn main() { let x = _vgsl_deadbeef__helper(1u); }");
  const helper = analysis.declarations.find((decl) => decl.name === "_vgsl_deadbeef__helper");
  const helperRefs = analysis.references.filter((ref) => ref.declarationId === helper?.id);

  expect(helper).toMatchObject({ kind: "function", safeToRename: true });
  expect(helperRefs).toHaveLength(1);
});

test("scope walker handles loop continuing and falls back for malformed var templates", () => {
  const analysis = analyzeWgslScopes("fn f() { loop { continuing { break; } } } fn g() { var<function x = 1u; }");

  expect(analysis.fallback.wholeModule).toBe(false);
  expect(analysis.functions.find((fn) => fn.name === "f")?.skipped).toBe(false);
  expect(analysis.functions.find((fn) => fn.name === "g")?.skipped).toBe(true);
  expect(analysis.functions.find((fn) => fn.name === "g")?.fallbackReasons.join("\n")).toContain("unparseable var template");
});

test("scope walker falls back whole-module for top-level ambiguity", () => {
  const analysis = analyzeWgslScopes("let localish = 1u; fn f() {}");

  expect(analysis.fallback.wholeModule).toBe(true);
  expect(analysis.fallback.reasons.join("\n")).toContain("unexpected top-level keyword 'let'");
});

test("scope walker should not treat identifiers in later global declarations as function signature types", () => {
  const analysis = analyzeWgslScopes("fn f() -> array<vec4f, 4> @must_use {} override O: u32 = 1u;");
  const overrideNameToken = analysis.tokens.findIndex((token) => token.text === "O");

  expect(overrideNameToken).toBeGreaterThan(-1);
  expect(analysis.preservedTokens.some((item) => item.tokenIndex === overrideNameToken && item.reason === "type")).toBe(false);
  expect(analysis.preservedTokens.some((item) => item.tokenIndex === overrideNameToken && item.reason === "global")).toBe(true);
  expect(analysis.fallback.wholeModule).toBe(false);
});

// #251: findStatementEnd() must stop at the declaration's own `;`. Comparison and shift
// operators in an initializer are not template brackets, so they must not extend the scan.
function localAudit(source: string, name: string) {
  const analysis = analyzeWgslScopes(source);
  const occurrences = analysis.tokens.filter((token) => token.kind === "ident" && token.text === name).length;
  const declarations = analysis.declarations.filter((decl) => decl.name === name).length;
  const references = analysis.references.filter((ref) => ref.name === name).length;
  const unknown = analysis.preservedTokens.filter((item) => item.reason === "unknown" && analysis.tokens[item.tokenIndex]?.text === name).length;
  return { occurrences, accounted: declarations + references, unknown };
}

const statementEndRows: [string, string][] = [
  ["single <", "let flag = uv.x < 1.0; if (flag) { return 0.0; } return 1.0;"],
  [">= then <=", "let flag = uv.x >= 0.0 && uv.x <= 1.0; if (!flag) { return 0.0; } return 1.0;"],
  ["< inside parens", "let flag = (uv.x < 1.0); if (!flag) { return 0.0; } return 1.0;"],
  ["var with <", "var flag = uv.x < 1.0; if (!flag) { return 0.0; } return 1.0;"],
  ["shift <<", "var flag = 1u << 2u; return f32(flag);"],
  ["shift >>", "var flag = 4u >> 1u; return f32(flag);"],
  ["single >", "let flag = uv.x > 1.0; if (flag) { return 0.0; } return 1.0;"],
  ["<= then >=", "let flag = uv.x <= 1.0 && uv.x >= 0.0; if (!flag) { return 0.0; } return 1.0;"],
  ["balanced < then >", "let flag = uv.x < 1.0 && uv.y > 0.0; if (!flag) { return 0.0; } return 1.0;"],
  ["no comparison", "let flag = true; if (!flag) { return 0.0; } return 1.0;"],
  ["typed with comparison", "let flag: bool = uv.x < 1.0; if (flag) { return 0.0; } return 1.0;"],
];

test.each(statementEndRows)("scope walker records every reference to a local whose initializer holds operators (%s)", (_label, body) => {
  const audit = localAudit(`fn helper_fn(uv: vec2f) -> f32 {\n  ${body}\n}\n`, "flag");

  expect(audit.occurrences).toBeGreaterThan(1);
  expect(audit.accounted).toBe(audit.occurrences);
  expect(audit.unknown).toBe(0);
});

test("scope walker ends a module-scope statement at its own semicolon when it contains a comparison", () => {
  const analysis = analyzeWgslScopes("const_assert 1u < 2u;\n@group(0) @binding(0) var<storage, read_write> data: array<f32>;\nfn f() -> f32 { return data[0]; }\n");
  const dataToken = analysis.tokens.findIndex((token) => token.text === "data");

  expect(analysis.preservedTokens.some((item) => item.tokenIndex === dataToken && item.reason === "global")).toBe(true);
  expect(analysis.declarations.some((decl) => decl.name === "data" && decl.kind === "global")).toBe(true);
  expect(analysis.fallback.wholeModule).toBe(false);
});

test("scope walker still preserves template type arguments after the #251 statement-end fix", () => {
  const source = "@group(0) @binding(0) var<storage, read_write> data: array<f32>; fn f() { var buf: array<f32, 4>; let first = buf[0]; }";
  const analysis = analyzeWgslScopes(source);
  const preserved = (text: string, reason: string) => analysis.preservedTokens.some((item) => analysis.tokens[item.tokenIndex]?.text === text && item.reason === reason);
  const buf = analysis.declarations.find((decl) => decl.name === "buf");

  expect(preserved("storage", "type")).toBe(true);
  expect(preserved("read_write", "type")).toBe(true);
  expect(preserved("array", "type")).toBe(true);
  expect(preserved("f32", "type")).toBe(true);
  expect(analysis.references.filter((ref) => ref.declarationId === buf?.id)).toHaveLength(1);
  expect(analysis.fallback.wholeModule).toBe(false);
});
