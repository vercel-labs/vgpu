import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { minifyWgsl } from "../src/runtime/minify.ts";
import { scan } from "../src/runtime/scanner.ts";

/**
 * WGSL's `decimal_float_literal` allows a leading dot (`.5`, `.5e2`, `.5f`), so the scanner has to
 * emit one number token for it. It used to emit `punct:.` + `number:5`, and the printer's
 * dot/digit separator rule then wrote `. 5` — text the device rejects with "unable to parse right
 * side of assignment". Two shaders that ship in this repo (`apps/docs/examples/fluid/divergence.wgsl`,
 * `project.wgsl`) contain `*.5*` and could not be minified at all.
 */

function tokenSummary(source: string): string {
  return scan(source).map((token) => `${token.kind}:${token.text}`).join(" | ");
}

test("scanner reads a leading-dot float as one number token", () => {
  expect(tokenSummary("let a = .5;")).toBe("keyword:let | ident:a | punct:= | number:.5 | punct:;");
  expect(tokenSummary("let a = -.5e2f;")).toBe("keyword:let | ident:a | punct:= | punct:- | number:.5e2f | punct:;");
});

test("scanner still reads a dot before a non-digit as punctuation", () => {
  // Member access and swizzles can never start with a digit, which is exactly why the leading-dot
  // number scan is unambiguous.
  expect(tokenSummary("let a = v.x;")).toBe("keyword:let | ident:a | punct:= | ident:v | punct:. | ident:x | punct:;");
  expect(tokenSummary("let a = c.xyz;")).toBe("keyword:let | ident:a | punct:= | ident:c | punct:. | ident:xyz | punct:;");
  expect(tokenSummary("let a = 1.;")).toBe("keyword:let | ident:a | punct:= | number:1. | punct:;");
});

test("minify keeps leading-dot float literals intact", () => {
  expect(minifyWgsl("out_buf[0] = .5;")).toBe("out_buf[0]=.5;");
  expect(minifyWgsl("let a = .0;")).toBe("let a=.0;");
  expect(minifyWgsl("let a = .5e2;")).toBe("let a=.5e2;");
  expect(minifyWgsl("let a = .5f;")).toBe("let a=.5f;");
  expect(minifyWgsl("let a = -.5;")).toBe("let a=-.5;");
  expect(minifyWgsl("let a = (.5);")).toBe("let a=(.5);");
  expect(minifyWgsl("let a = max(.5,1.0);")).toBe("let a=max(.5,1.0);");
  expect(minifyWgsl("let a = array<f32,2>(.5,1.0);")).toBe("let a=array<f32,2>(.5,1.0);");
  expect(minifyWgsl("let a = x*.25;")).toBe("let a=x*.25;");
  expect(minifyWgsl("let a = .5 /* comment */ + 1.0;")).toBe("let a=.5+1.0;");
});

test("minify keeps the shipped fluid-shader expression intact", () => {
  // Provenance: the `*.5*` expression below is copied from
  // apps/docs/examples/fluid/divergence.wgsl (`divergence[index_of(p,grid.size)]=…`).
  expect(minifyWgsl("d[i(p,g.size)] = (r-l)*.5*f32(g.size.x) + (t-b)*.5*f32(g.size.y);"))
    .toBe("d[i(p,g.size)]=(r-l)*.5*f32(g.size.x)+(t-b)*.5*f32(g.size.y);");
});

test("minify leaves every other number and member-access form as it was", () => {
  // Over-fix guards: these outputs are byte-identical to the pre-fix minifier.
  expect(minifyWgsl("let a = 0.5;")).toBe("let a=0.5;");
  expect(minifyWgsl("let a = 1.;")).toBe("let a=1.;");
  expect(minifyWgsl("let a = 1.e3;")).toBe("let a=1.e3;");
  expect(minifyWgsl("let a = 1e3;")).toBe("let a=1e3;");
  expect(minifyWgsl("let a = 0x1p1;")).toBe("let a=0x1p1;");
  expect(minifyWgsl("let a = 0x1.8p1;")).toBe("let a=0x1.8p1;");
  expect(minifyWgsl("let a = 0xFFu;")).toBe("let a=0xFFu;");
  expect(minifyWgsl("let a = 0.5 + 1. + 1.e3 + 1e3 + 0x1p1 + 0x1.8p1 + 0xFFu;")).toBe("let a=0.5+1.+1.e3+1e3+0x1p1+0x1.8p1+0xFFu;");
  expect(minifyWgsl("let a = v.x + v.y;")).toBe("let a=v.x+v.y;");
  expect(minifyWgsl("let a = c.xyz;")).toBe("let a=c.xyz;");
  expect(minifyWgsl("let a = s.inner.value;")).toBe("let a=s.inner.value;");
  expect(minifyWgsl("let a = vec2f(1.0,2.0).x;")).toBe("let a=vec2f(1.0,2.0).x;");
  expect(minifyWgsl("let a = v./* comment */x;")).toBe("let a=v.x;");
});

test("minify does not invent a leading-dot float where the source did not have one", () => {
  // A dot separated from the digits is not a float literal in the input, so the printer must not
  // fuse it into one: these keep their separators, exactly as before the fix.
  expect(minifyWgsl("let a = . 5;")).toBe("let a=. 5;");
  expect(minifyWgsl("let a = 1 . 5;")).toBe("let a=1 . 5;");
});

test("resolveShader minifies a leading-dot float in an imported module", async () => {
  const modules = {
    "/entry.wgsl": "import { half_of } from \"./lib.wgsl\";\n@group(0) @binding(0) var<storage, read_write> out_buf: array<f32>;\n@compute @workgroup_size(1) fn main() {\n  out_buf[0] = half_of(3.0) * .5;\n}\n",
    "/lib.wgsl": "export fn half_of(v: f32) -> f32 {\n  return v * .5;\n}\n",
  };
  const result = await resolveShader({ entry: "/entry.wgsl", modules, minify: true });
  expect(result.wgsl).not.toContain(". 5");
  expect(result.wgsl).toContain("*.5");
  expect((result.wgsl.match(/\*\.5/g) ?? []).length).toBe(2);
});
