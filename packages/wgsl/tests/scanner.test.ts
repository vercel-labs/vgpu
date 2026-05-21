import { expect, test } from "vitest";
import { parseModule } from "../src/runtime/parser.ts";
import { hasTopLevelImport, scan } from "../src/runtime/scanner.ts";

test("scanner emits atomic comments", () => expect(scan("/* import x */ fn f(){}")[0]).toMatchObject({ kind: "blockComment" }));
test("scanner identifies declarations", () => expect(parseModule(scan("fn f(){} struct S{} const C=1; alias A=u32; var<private> v:u32; override O=1; ")).locals.map((x) => x.name)).toEqual(["f", "S", "C", "A", "v", "O"]));
test("unterminated block comment rejected", () => expect(() => scan("/* nope")).toThrow(expect.objectContaining({ code: "VGPU-WGSL-LEX-UNTERM-COMMENT" })));
test("scanner emits comments atomically", () => {
  const tokens = scan("// import { x } from './x'\nlet color = 1;");
  expect(tokens[0]).toMatchObject({ kind: "lineComment" });
  expect(tokens.map((token) => token.text)).toContain("color");
});

test("scanner keeps signed decimal exponents in one number token", () => {
  expect(scan("let x = 1e-8 + 1E+8 + 1.0e-8 + 1.e+8;").filter((token) => token.kind === "number").map((token) => token.text))
    .toEqual(["1e-8", "1E+8", "1.0e-8", "1.e+8"]);
});

test("scanner keeps signed hex exponents in one number token", () => {
  expect(scan("let x = 0x1p-8 + 0x1p+8 + 0x1P-8 + 0x1P+8 + 0x1.8p-2;").filter((token) => token.kind === "number").map((token) => token.text))
    .toEqual(["0x1p-8", "0x1p+8", "0x1P-8", "0x1P+8", "0x1.8p-2"]);
});

test("hasTopLevelImport skips top-level WGSL directives before imports", () => {
  expect(hasTopLevelImport("enable f16;\nrequires readonly_and_readwrite_storage_textures;\nimport { helper } from './helper.wgsl';")).toBe(true);
  expect(hasTopLevelImport("diagnostic(off, derivative_uniformity);\nimport { helper } from './helper.wgsl';")).toBe(true);
  expect(hasTopLevelImport("// leading comment\n/* block */\ndiagnostic(warning, chromium_unreachable_code);\nimport { helper } from './helper.wgsl';")).toBe(true);
});

test("hasTopLevelImport only skips complete top-level directives", () => {
  expect(hasTopLevelImport("diagnostic(off, derivative_uniformity)\nfn main(){}\nimport { helper } from './helper.wgsl';")).toBe(false);
  expect(hasTopLevelImport("fn diagnostic(){}\nimport { helper } from './helper.wgsl';")).toBe(false);
});
