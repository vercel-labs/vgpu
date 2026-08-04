import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

/**
 * Regression coverage for the black-box stress finding "F3": a module-scope declaration
 * disappeared from the emitted WGSL whenever *any* function-scope local anywhere in the module
 * happened to reuse its name.
 *
 * Mechanism: `substitute()` in `mangler.ts` tracked shadowing in a flat, name-keyed `Set<string>`
 * that was never scoped and never cleared. The first local named `helper` (a `let` in a nested
 * block, a `for` loop variable, or even a parameter of an unrelated function) permanently
 * suppressed mangling for *every later* `helper` token in the module. The declaration itself was
 * emitted as `_vgsl_<hash>__helper` while the real module-scope call site stayed `helper`, so
 * declaration DCE then correctly saw the mangled declaration as unreferenced and deleted it. The
 * device rejected the result with `unresolved call target 'helper'` — at every minify setting,
 * `minify: false` included.
 *
 * Every source below is valid WGSL (verified against naga directly), so `validate: "require"` is
 * used whenever this runner has a device.
 */

const hasDevice = process.env.VGPU_DOCKER_TEST === "1";
const validate = hasDevice ? ("require" as const) : false;

const OUT_BUF = `@group(0) @binding(0) var<storage, read_write> out_buf: array<f32>;`;

const mangled = (kind: string, name: string) => new RegExp(`\\b${kind} _vgsl_[0-9a-f]{8}__${name}\\b`);
const countDeclarations = (wgsl: string, kind: string) => (wgsl.match(new RegExp(`\\b${kind}\\s`, "g")) ?? []).length;

async function resolve(source: string, minify: boolean, extra: Record<string, string> = {}): Promise<string> {
  const resolved = await resolveShader({ entry: "/main.wgsl", validate, minify, modules: { "/main.wgsl": source, ...extra } });
  return resolved.wgsl;
}

/** The five confirmed F3 shapes, each with the module-scope declaration it must not lose. */
const shadowShapes = [
  {
    name: "let in a nested block shadows a module-scope fn",
    source: `${OUT_BUF}
fn helper(x: f32) -> f32 { return x * 2.0; }
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  { let helper = acc * 3.0; acc = acc + helper; }
  acc = acc + helper(acc);
  out_buf[0] = acc;
}
`,
    kind: "fn",
    symbol: "helper",
  },
  {
    name: "let in a nested block shadows a module-scope struct used later as a type",
    source: `${OUT_BUF}
struct S { value: f32 }
fn make() -> S { return S(2.0); }
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  { let S = acc * 3.0; acc = acc + S; }
  let produced: S = make();
  out_buf[0] = acc + produced.value;
}
`,
    kind: "struct",
    symbol: "S",
  },
  {
    name: "let in a nested block shadows a module-scope const",
    source: `${OUT_BUF}
const K: f32 = 7.0;
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  { let K = acc * 3.0; acc = acc + K; }
  out_buf[0] = acc + K;
}
`,
    kind: "const",
    symbol: "K",
  },
  {
    name: "a parameter of an unrelated function shadows a module-scope fn",
    source: `${OUT_BUF}
fn helper(x: f32) -> f32 { return x * 2.0; }
fn other(helper: f32) -> f32 { return helper + 1.0; }
@compute @workgroup_size(1) fn main() {
  out_buf[0] = helper(1.0) + other(2.0);
}
`,
    kind: "fn",
    symbol: "helper",
  },
  {
    name: "a for loop variable shadows a module-scope fn",
    source: `${OUT_BUF}
fn helper(x: f32) -> f32 { return x * 2.0; }
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  for (var helper = 0; helper < 3; helper = helper + 1) { acc = acc + f32(helper); }
  out_buf[0] = acc + helper(acc);
}
`,
    kind: "fn",
    symbol: "helper",
  },
] as const;

for (const shape of shadowShapes) {
  test(`${shape.name} (minify: false)`, async () => {
    const wgsl = await resolve(shape.source, false);
    expect(wgsl).toMatch(mangled(shape.kind, shape.symbol));
  });

  test(`${shape.name} (minify: true)`, async () => {
    const wgsl = await resolve(shape.source, true);
    // Identifier minification renames the mangled symbol, so assert on structure: the declaration
    // is still there. `fn` also counts `fn main`, hence the +1 for the fn shapes.
    const expected = shape.kind === "fn" ? countDeclarations(shape.source, "fn") : countDeclarations(shape.source, shape.kind);
    expect(countDeclarations(wgsl, shape.kind)).toBe(expected);
  });
}

test("an imported helper survives a same-named local in the entry module", async () => {
  const wgsl = await resolve(
    `import { helper } from "./lib.wgsl";
${OUT_BUF}
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  { let helper = acc * 3.0; acc = acc + helper; }
  out_buf[0] = helper(acc);
}
`,
    false,
    { "/lib.wgsl": `export fn helper(x: f32) -> f32 { return x * 2.0; }` },
  );

  expect(wgsl).toMatch(mangled("fn", "helper"));
});

test("a local shadow does not resurrect a genuinely dead module declaration", async () => {
  const wgsl = await resolve(
    `${OUT_BUF}
fn deadAndShadowed(x: f32) -> f32 { return x * 2.0; }
fn deadOnly(x: f32) -> f32 { return x * 3.0; }
struct DeadStruct { value: f32 }
const DEAD_CONST: f32 = 9.0;
fn live(x: f32) -> f32 { return x + 1.0; }
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  { let deadAndShadowed = acc * 3.0; acc = acc + deadAndShadowed; }
  out_buf[0] = live(acc);
}
`,
    false,
  );

  expect(wgsl).toMatch(mangled("fn", "live"));
  expect(wgsl).not.toMatch(mangled("fn", "deadAndShadowed"));
  expect(wgsl).not.toMatch(mangled("fn", "deadOnly"));
  expect(wgsl).not.toMatch(mangled("struct", "DeadStruct"));
  expect(wgsl).not.toMatch(mangled("const", "DEAD_CONST"));
});

test("a shadowing local keeps its own name and is not rewritten to the module symbol", async () => {
  const wgsl = await resolve(
    `${OUT_BUF}
const K: f32 = 7.0;
@compute @workgroup_size(1) fn main() {
  var acc = 1.0;
  { let K = acc * 3.0; acc = acc + K; }
  out_buf[0] = acc + K;
}
`,
    false,
  );

  // Inside the block the reference belongs to the local, so it must stay unmangled; outside it
  // resolves to the module-scope const and must be mangled.
  expect(wgsl).toContain("let K = acc * 3.0; acc = acc + K;");
  expect(wgsl).toMatch(/out_buf\[0\] = acc \+ _vgsl_[0-9a-f]{8}__K;/);
});

test("a reference before the shadowing declaration in the same block still binds to the module symbol", async () => {
  const wgsl = await resolve(
    `${OUT_BUF}
fn helper(x: f32) -> f32 { return x * 2.0; }
@compute @workgroup_size(1) fn main() {
  let first = helper(1.0);
  let helper = first * 3.0;
  out_buf[0] = helper;
}
`,
    false,
  );

  expect(wgsl).toMatch(/let first = _vgsl_[0-9a-f]{8}__helper\(1\.0\);/);
  expect(wgsl).toContain("let helper = first * 3.0;");
});
