import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { minifyWgsl } from "../src/runtime/minify.ts";
import { reflectSource } from "../src/runtime/reflect-source.ts";
import { scan } from "../src/runtime/scanner.ts";

/**
 * The scanner is ASCII-only (`[A-Za-z_]` then `[A-Za-z0-9_]`) while WGSL identifiers are Unicode
 * (XID_Start / XID_Continue). That mismatch produced two families of bad behaviour:
 *
 * - **Silent corruption.** A leading non-ASCII character fell through to the punctuation path, and
 *   the token printer's separator predicates are ASCII-only too, so `let Ω = 1.0;` printed as
 *   `letΩ=1.0;` — one fused token no device accepts (black-box F2).
 * - **Bogus diagnostics.** In declaration positions the parser asked for an `ident` and got a
 *   `punct`: `fn åhelper` reported "Expected identifier", and `const Ω: f32` mangled the *type*
 *   and blamed a missing bind group (black-box F5, white-box F2).
 *
 * `café`-class names (ASCII start, non-ASCII continuation) round-tripped through the printer, but
 * they are scanned as *fragments* (`ident:caf` + `punct:é`), and the fragment — not the identifier
 * — is what reaches reflection. Measured on the pre-fix build, at every minify setting including
 * `minify: false`:
 *
 * ```
 * @compute fn maín()                      -> reflection.entryPoints[0].name === "ma"
 * var<storage, read_write> sínk: array<f32>-> reflection.bindings[0].name === "s"
 * struct Params { café: f32 }             -> layout member name === "caf"
 * ```
 *
 * Those names are the pipeline's `entryPoint` string and the keys callers bind and write buffers
 * by, so the café class corrupts a user-visible contract silently as well. Both classes are
 * therefore rejected at scan time with one diagnostic instead of being half-supported.
 *
 * Unicode identifier support is tracked in https://github.com/vercel-labs/vgpu/issues/294.
 */

const CODE = "VGPU-WGSL-IDENT-NONASCII";
const ISSUE = "https://github.com/vercel-labs/vgpu/issues/294";
const OUT_BUF = `@group(0) @binding(0) var<storage, read_write> out_buf: array<f32>;`;
const hasDevice = process.env.VGPU_DOCKER_TEST === "1";
const validate = hasDevice ? ("require" as const) : false;
const minifyModes = [false, { whitespace: true }, { whitespace: true, identifiers: "safe" as const }, true] as const;

type Rejection = Error & {
  code?: string;
  line?: number;
  column?: number;
  fix?: string;
  range?: { file?: string; start?: { line: number; column: number } };
};

function rejection(run: () => unknown): Rejection {
  try {
    run();
  } catch (error) {
    return error as Rejection;
  }
  throw new Error(`expected ${CODE}, but the call returned normally`);
}

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    return error as Rejection;
  }
  throw new Error(`expected ${CODE}, but resolveShader returned normally`);
}

/** Every rejection must name the identifier, carry a position, and point at the tracking issue. */
function expectRejection(error: Rejection, identifier: string, file?: string): void {
  expect(error.code).toBe(CODE);
  expect(error.message).toContain(identifier);
  expect(error.fix).toContain(ISSUE);
  expect(error.fix).toContain(identifier);
  if (file !== undefined) {
    expect(error.message).toContain(file);
    expect(error.range?.file).toBe(file);
  }
}

test("scanner rejects an identifier that starts with a non-ASCII character", () => {
  const error = rejection(() => scan("let Ω = 1.0;"));
  expectRejection(error, "Ω");
  expect(error.line).toBe(1);
  expect(error.column).toBe(5);
});

test("scanner reports the position of the identifier, not of the non-ASCII character", () => {
  // `café` is scanned as `ident:caf` + the offending `é`; the diagnostic points at `c`.
  const error = rejection(() => scan("fn f() {\n  let x = 1.0;\n  let café = x;\n}"));
  expectRejection(error, "café");
  expect(error.line).toBe(3);
  expect(error.column).toBe(7);
  expect(error.range?.start).toEqual({ line: 3, column: 7 });
});

test("scanner names the whole offending identifier for every script", () => {
  expectRejection(rejection(() => scan("var åx = 1.0;")), "åx");
  expectRejection(rejection(() => scan("let αβ = 1.0;")), "αβ");
  expectRejection(rejection(() => scan("let 变量 = 1.0;")), "变量");
  expectRejection(rejection(() => scan("let ångström = 1.0;")), "ångström");
  expectRejection(rejection(() => scan("let señal = 1.0;")), "señal");
  // Astral-plane characters are one code point in two UTF-16 units; both must land in the message.
  expectRejection(rejection(() => scan("let 😀 = 1.0;")), "😀");
});

test("scanner rejects a stray non-ASCII symbol in code position", () => {
  const error = rejection(() => scan("let x = 1.0; €"));
  expect(error.code).toBe(CODE);
  expect(error.message).toContain("€");
});

test("every declaration and statement position rejects instead of corrupting or misdiagnosing", async () => {
  const shapes: readonly (readonly [string, string, string])[] = [
    ["let", `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { let Ω = 1.0; out_buf[0] = Ω; }`, "Ω"],
    ["var", `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { var åx = 1.0; out_buf[0] = åx; }`, "åx"],
    ["module const", `${OUT_BUF}\nconst Ω: f32 = 1.0;\n@compute @workgroup_size(1) fn main() { out_buf[0] = Ω; }`, "Ω"],
    ["module var", `${OUT_BUF}\nvar<private> Ω: f32 = 1.0;\n@compute @workgroup_size(1) fn main() { out_buf[0] = Ω; }`, "Ω"],
    ["override", `${OUT_BUF}\noverride Ω: f32 = 1.0;\n@compute @workgroup_size(1) fn main() { out_buf[0] = Ω; }`, "Ω"],
    ["fn name", `${OUT_BUF}\nfn åhelper(v: f32) -> f32 { return v; }\n@compute @workgroup_size(1) fn main() { out_buf[0] = åhelper(1.0); }`, "åhelper"],
    ["fn param", `${OUT_BUF}\nfn helper(变量: f32) -> f32 { return 变量; }\n@compute @workgroup_size(1) fn main() { out_buf[0] = helper(1.0); }`, "变量"],
    ["struct name", `${OUT_BUF}\nstruct åS { v: f32 }\n@compute @workgroup_size(1) fn main() { let s = åS(1.0); out_buf[0] = s.v; }`, "åS"],
    ["struct member", `${OUT_BUF}\nstruct S { åv: f32 }\n@compute @workgroup_size(1) fn main() { let s = S(1.0); out_buf[0] = s.åv; }`, "åv"],
    ["alias", `${OUT_BUF}\nalias Åf = f32;\n@compute @workgroup_size(1) fn main() { let v: Åf = 1.0; out_buf[0] = v; }`, "Åf"],
    ["adjacent keyword", `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { let αβ = 1.0; out_buf[0] = αβ; }`, "αβ"],
    ["if/else", `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { var Ω = 1.0; if (Ω > 0.0) { Ω = 2.0; } else { Ω = 3.0; } out_buf[0] = Ω; }`, "Ω"],
    ["for", `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { var s = 0.0; for (var Ω = 0; Ω < 4; Ω++) { s += 1.0; } out_buf[0] = s; }`, "Ω"],
    ["loop", `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { var Ω = 0.0; loop { Ω += 1.0; if (Ω > 2.0) { break; } } out_buf[0] = Ω; }`, "Ω"],
    ["return", `${OUT_BUF}\nfn helper() -> f32 { let Ω = 1.0; return Ω; }\n@compute @workgroup_size(1) fn main() { out_buf[0] = helper(); }`, "Ω"],
    ["entry point name", `${OUT_BUF}\n@compute @workgroup_size(1) fn maín() { out_buf[0] = 1.0; }`, "maín"],
    ["binding name", `@group(0) @binding(0) var<storage, read_write> sínk: array<f32>;\n@compute @workgroup_size(1) fn main() { sínk[0] = 1.0; }`, "sínk"],
  ];
  for (const [label, source, identifier] of shapes) {
    for (const minify of minifyModes) {
      const error = await rejectionOf(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, minify, validate: false }));
      expect(error.code, `${label} @ ${JSON.stringify(minify)}`).toBe(CODE);
      expectRejection(error, identifier, "/m.wgsl");
    }
    // The scanner runs before validation, so `validate: "require"` cannot mask or replace it.
    const withValidate = await rejectionOf(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, minify: true, validate }));
    expect(withValidate.code, label).toBe(CODE);
  }
});

test("an imported module is blamed by its own path", async () => {
  const modules = {
    "/entry.wgsl": `import { helper } from "./lib.wgsl";\n${OUT_BUF}\n@compute @workgroup_size(1) fn main() { out_buf[0] = helper(1.0); }`,
    "/lib.wgsl": `export fn helper(v: f32) -> f32 { let Ω = v * 2.0; return Ω; }`,
  };
  const error = await rejectionOf(resolveShader({ entry: "/entry.wgsl", modules, minify: true, validate: false }));
  expectRejection(error, "Ω", "/lib.wgsl");
  expect(error.line).toBe(1);
});

test("the café class is rejected too, for the reflection corruption in the file header", async () => {
  const cafe = `${OUT_BUF}\n@compute @workgroup_size(1) fn main() { let café = 1.0; out_buf[0] = café; }`;
  for (const minify of minifyModes) {
    expectRejection(await rejectionOf(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": cafe }, minify, validate: false })), "café", "/m.wgsl");
  }
  expectRejection(rejection(() => minifyWgsl(cafe)), "café");
  expectRejection(rejection(() => reflectSource(cafe, "/m.wgsl")), "café", "/m.wgsl");
});

test("reflectSource and minifyWgsl reject on their own, so no caller can skip the check", () => {
  expectRejection(rejection(() => minifyWgsl("let Ω = 1.0;")), "Ω");
  expectRejection(rejection(() => reflectSource(`${OUT_BUF}\n@compute @workgroup_size(1) fn main() { let Ω = 1.0; out_buf[0] = Ω; }`, "/m.wgsl")), "Ω", "/m.wgsl");
});

test("non-ASCII text in comments stays legal", () => {
  expect(scan("// señal: acumulador de la métrica 😀 变量\nlet x = 1.0;").map((token) => token.kind))
    .toEqual(["lineComment", "keyword", "ident", "punct", "number", "punct"]);
  expect(scan("/* señal 😀 变量 */ let x = 1.0;")[0]).toMatchObject({ kind: "blockComment" });
  expect(minifyWgsl("// señal 😀 变量\nlet x = 1.0;")).toBe("let x=1.0;");
  expect(minifyWgsl("let /* señal 😀 */ x = 1.0;")).toBe("let x=1.0;");
  expect(minifyWgsl("let x = 1.0; // señal é")).toBe("let x=1.0;");
  // A comment holding non-ASCII text is still dropped without leaking a separator into the output.
  expect(minifyWgsl("let x = 4.0 / /* café */ 2.0;")).toBe("let x=4.0/2.0;");
});

test("non-ASCII comments survive every minify mode byte-exactly", async () => {
  const source = `${OUT_BUF}\n// Acumulador de la métrica (señal 😀 变量)\n@compute @workgroup_size(1) fn main() {\n  /* paso 1: inicializar el búfer */\n  let valor = 1.0; // ¡listo!\n  out_buf[0] = valor;\n}`;
  const modules = { "/m.wgsl": source };
  const plain = await resolveShader({ entry: "/m.wgsl", modules, minify: false, validate });
  expect(plain.wgsl).toContain("señal 😀 变量");
  expect(plain.wgsl).toContain("búfer");
  expect(plain.wgsl).toContain("¡listo!");
  const expectedMinified = `@group(0) @binding(0) var<storage,read_write> out_buf:array<f32>;@compute @workgroup_size(1) fn main(){let valor=1.0;out_buf[0]=valor;}`;
  const whitespace = await resolveShader({ entry: "/m.wgsl", modules, minify: { whitespace: true }, validate });
  expect(whitespace.wgsl).toBe(expectedMinified);
  const identifiers = await resolveShader({ entry: "/m.wgsl", modules, minify: true, validate });
  expect(identifiers.wgsl).toBe(expectedMinified.replace(/valor/g, "a"));
});

test("non-ASCII characters in strings and import paths stay legal", async () => {
  expect(scan(`import { helper } from "./señal.wgsl";`).map((token) => token.text))
    .toEqual(["import", "{", "helper", "}", "from", `"./señal.wgsl"`, ";"]);
  const modules = {
    "/entry.wgsl": `import { helper } from "./señal.wgsl";\n${OUT_BUF}\n@compute @workgroup_size(1) fn main() { out_buf[0] = helper(1.0); }`,
    "/señal.wgsl": `export fn helper(v: f32) -> f32 { return v * 2.0; }`,
  };
  const resolved = await resolveShader({ entry: "/entry.wgsl", modules, minify: true, validate });
  expect(resolved.wgsl).toContain("out_buf[0]=");
});

test("a byte-order mark and other non-ASCII blankspace are still skipped, not rejected", async () => {
  expect(scan("\uFEFFlet x = 1.0;").map((token) => token.text)).toEqual(["let", "x", "=", "1.0", ";"]);
  const source = `\uFEFF${OUT_BUF}\n@compute @workgroup_size(1) fn main() { out_buf[0] = 1.0; }`;
  const resolved = await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": source }, minify: true, validate });
  expect(resolved.wgsl).toContain("out_buf[0]=1.0;");
});

test("ASCII shaders are untouched", () => {
  expect(scan("let a = .5;").map((token) => `${token.kind}:${token.text}`).join(" | "))
    .toBe("keyword:let | ident:a | punct:= | number:.5 | punct:;");
  expect(minifyWgsl("let a = v.x + 1.0;")).toBe("let a=v.x+1.0;");
});
