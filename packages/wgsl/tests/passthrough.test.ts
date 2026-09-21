import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { compile } from "../src/index.ts";

test("compile passes plain WGSL through", () => {
  const source = "@compute @workgroup_size(1) fn main() {}";

  expect(compile(source)).toMatchObject({ kind: "wgsl", wgsl: source, diagnostics: [] });
});

test("compile derives passthrough metadata from the unchanged source", () => {
  const source = "@compute @workgroup_size(1)\r\nfn ma\u0301in() {\r\n}\n";
  const compiled = compile(source);

  expect(compiled.wgsl).toBe(source);
  expect(compiled.source).toEqual({ text: source, path: "<runtime>", imports: [] });
  expect(compiled.ast.modules).toEqual([{ path: "<runtime>", text: source }]);
  expect(compiled.ast.sourceMap).toBe(compiled.sourceMap);
  expect(compiled.cacheKey).toEqual(compile(source).cacheKey);
  expect(compiled.cacheKey).not.toEqual(compile(source.normalize()).cacheKey);
  expect(compiled.stats).toEqual({ lines: 4, bytes: new TextEncoder().encode(source).byteLength, bindGroups: 0 });
});

test("compile rejects runtime imports", () => {
  const act = () => compile('import { x } from "./x";');
  expect(act).toThrow(/Runtime WGSL/);
  expect(act).toThrow(expect.objectContaining({ code: "VGPU-WGSL-RUNTIME-IMPORT" }));

  expect(() => compile('/* preface */ // more preface\nimport { x } from "./x";')).toThrow(
    expect.objectContaining({ code: "VGPU-WGSL-RUNTIME-IMPORT" }),
  );
  expect(() => compile('// import { x } from "./x";\n@vertex fn main() {}')).not.toThrow();
});

test("compile reports compute entry points with surrounding attributes", () => {
  const source = `
    @diagnostic(off, derivative_uniformity)
    @compute
    @workgroup_size(WORKGROUP_SIZE * ((2 + 2)))
    @must_use
    fn simulate() {}

    @workgroup_size(8, 8) @compute fn shade() {}
  `;

  expect(compile(source).entryPoints).toEqual(["simulate", "shade"]);
});

test("compile preserves every entry point name and source order", () => {
  const source = `
    @vertex fn main_loop() {}
    @fragment fn _main() {}
    @compute @workgroup_size(1) fn maín() {}
    @vertex fn Ωmain() {}
    @fragment fn ma\u0301in() {}
    @compute @workgroup_size(1) fn 𐐀main() {}
  `;

  expect(compile(source).entryPoints).toEqual(["main_loop", "_main", "maín", "Ωmain", "ma\u0301in", "𐐀main"]);
});

test("compile treats comments as token boundaries and ignores commented functions", () => {
  const source = `
    /*
      @vertex fn blockGhost() {}
      /* @fragment fn nestedGhost() {} */
    */
    // Block delimiters stay inert here: /* @compute fn lineGhost() {} */
    @/**/compute/**/@workgroup_size(1)/**/fn/* separator */main/* separator */() {}
  `;

  expect(compile(source).entryPoints).toEqual(["main"]);
});

test("compile associates stage attributes only with their top-level function declaration", () => {
  const source = `
    @vertex_like fn almostVertex() {}
    @fragmented fn almostFragment() {}
    @compute2 fn almostCompute() {}
    @location(0) fn helper() { @vertex fn nestedGhost() {} }
    @compute const unrelated = 1;
    fn auxiliary() {}
    @fragment struct Incompatible { @location(0) value: f32 }
    @compute fn missingName;
    @vertex fn vertexMain() {}
    @compute @workgroup_size(1) fn computeMain() {}
    @fragment fn missingParen;
  `;

  expect(compile(source).entryPoints).toEqual(["vertexMain", "computeMain"]);
});

test("compile consumes incomplete attributes without matching a later declaration", () => {
  const source = `
    @vertex fn before() {}
    @compute @workgroup_size((1)
    @fragment fn after() {}
  `;

  expect(compile(source).entryPoints).toEqual(["before"]);
  expect(compile("@compute @workgroup_size(1) /* unterminated").entryPoints).toEqual([]);
});

test("compile terminates for incomplete declarations followed by a line comment at EOF", () => {
  // Isolate the synchronous call so a regression cannot hang the test runner.
  const sources = ["@vertex fn // EOF", "@ // EOF", "@vertex fn before() {} @fragment fn // EOF"];
  const child = spawnSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "--eval",
    `import { compile } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
     console.log(JSON.stringify(${JSON.stringify(sources)}.map(source => compile(source).entryPoints)));`,
  ], { encoding: "utf8", timeout: 3000 });

  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual([[], [], ["before"]]);
});

test.each(["\n", "\r\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029"])(
  "compile ends line comments at WGSL line ending %j",
  (ending) => {
    const source = `// @vertex fn commented() {}${ending}@fragment fn main() {}`;

    expect(compile(source).entryPoints).toEqual(["main"]);
  },
);

test.each(["\t", "\n", "\v", "\f", "\r", " ", "\u0085", "\u200e", "\u200f", "\u2028", "\u2029"])(
  "compile accepts WGSL blankspace %j between tokens",
  (space) => {
    const source = `${space}@${space}fragment${space}fn${space}main${space}() {}`;

    expect(compile(source).entryPoints).toEqual(["main"]);
  },
);
