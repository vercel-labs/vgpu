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

/**
 * A parameter's scope is the function *body* compound statement, so the rest of the signature —
 * sibling parameter types, their template arguments and the `-> ReturnType` — still resolves to
 * module scope. The first version of this fix hid the name from the parameter's own token through
 * the end of the body, which swallowed those type positions and reproduced F3 in a new corner:
 * `struct helper` was emitted as `_vgsl_<hash>__helper` while `other: helper` kept the bare name,
 * so the device rejected the shader with `unresolved type 'helper'`. Reported by review on #287.
 */
test("a parameter does not shadow module types in sibling parameters or the return type", async () => {
  for (const minify of [false, true]) {
    const wgsl = await resolve(
      `${OUT_BUF}
struct helper { v: f32 }
fn takes(helper: f32, other: helper) -> helper { return other; }
@compute @workgroup_size(1) fn main() { out_buf[0] = takes(1.0, helper(2.0)).v; }
`,
      minify,
    );

    expect(wgsl).toMatch(mangled("struct", "helper"));
    // Both type positions after the parameter are still mangled. Asserted structurally because
    // `minify: true` also renames the parameter itself (`helper` -> `b`), which is fine.
    expect(wgsl).toMatch(/,\s*\w+\s*:\s*_vgsl_[0-9a-f]{8}__helper\s*\)/);
    expect(wgsl).toMatch(/->\s*_vgsl_[0-9a-f]{8}__helper/);
    // The bug left these positions naming a struct that no longer existed under that name.
    expect(wgsl).not.toMatch(/->\s*helper\b/);
  }
});

test("a parameter does not shadow a module type inside a sibling parameter's template arguments", async () => {
  const wgsl = await resolve(
    `${OUT_BUF}
struct helper { v: f32 }
fn takes(helper: f32, p: ptr<function, helper>) -> f32 { return (*p).v + helper; }
@compute @workgroup_size(1) fn main() {
  var s = helper(3.0);
  out_buf[0] = takes(1.0, &s);
}
`,
    false,
  );

  expect(wgsl).toMatch(mangled("struct", "helper"));
  expect(wgsl).toMatch(/ptr<function, _vgsl_[0-9a-f]{8}__helper>/);
});

test("an imported type survives being named by a parameter of the function that uses it", async () => {
  const wgsl = await resolve(
    `import { helper } from "./lib.wgsl";
${OUT_BUF}
fn takes(helper: f32, other: helper) -> helper { return other; }
@compute @workgroup_size(1) fn main() { out_buf[0] = takes(1.0, helper(2.0)).v; }
`,
    false,
    { "/lib.wgsl": `export struct helper { v: f32 }` },
  );

  expect(wgsl).toMatch(mangled("struct", "helper"));
  expect(wgsl).toMatch(/\(helper: f32, other: _vgsl_[0-9a-f]{8}__helper\) -> _vgsl_[0-9a-f]{8}__helper/);
});

test("a parameter still shadows a same-named module symbol inside the body", async () => {
  const wgsl = await resolve(
    `${OUT_BUF}
struct helper { v: f32 }
fn takes(helper: f32) -> f32 { return helper * 2.0; }
@compute @workgroup_size(1) fn main() {
  var s = helper(5.0);
  out_buf[0] = takes(4.0) + s.v;
}
`,
    false,
  );

  // In the body `helper` is the parameter, so it must not be rewritten to the struct's mangled name.
  expect(wgsl).toContain("(helper: f32) -> f32 { return helper * 2.0; }");
  expect(wgsl).toMatch(/var s = _vgsl_[0-9a-f]{8}__helper\(5\.0\);/);
});
