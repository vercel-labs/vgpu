import { describe, expect, test } from "vitest";
import { parseModule } from "../src/runtime/parser.ts";
import { scan } from "../src/runtime/scanner.ts";

describe("s3 §8 1-39", () => {
  test("1 scanner emits atomic comments", () => expect(scan("/* import x */ fn f(){}")[0]).toMatchObject({ kind: "blockComment" }));
  test("2 scanner identifies declarations", () => expect(parseModule(scan("fn f(){} struct S{} const C=1; alias A=u32; var<private> v:u32; override O=1; ")).locals.map((x) => x.name)).toEqual(["f", "S", "C", "A", "v", "O"]));
  test("4 unterminated block comment rejected", () => expect(() => scan("/* nope")).toThrow(expect.objectContaining({ code: "VGPU-WGSL-LEX-UNTERM-COMMENT" })));
});

describe("s3", () => {
  test("1: scanner emits comments atomically", () => {
    const tokens = scan("// import { x } from './x'\nlet color = 1;");
    expect(tokens[0]).toMatchObject({ kind: "lineComment" });
    expect(tokens.map((token) => token.text)).toContain("color");
  });
});
