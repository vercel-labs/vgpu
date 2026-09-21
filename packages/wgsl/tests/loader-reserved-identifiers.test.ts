import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { transformWgsl } from "@vgpu/wgsl/loader-vite";
import wgslWebpackLoader from "@vgpu/wgsl/loader-webpack";
import { compile } from "../src/index.ts";

const RESERVED_LEAF = "struct Paint {\n  from: vec2f,\n}\n@fragment fn fs() -> @location(0) vec4f { var p: Paint; return vec4f(p.from, 0.0, 1.0); }\n";
const CLEAN_LEAF = "struct Paint {\n  start: vec2f,\n}\n@fragment fn fs() -> @location(0) vec4f { var p: Paint; return vec4f(p.start, 0.0, 1.0); }\n";

/** Drives the webpack loader through both its sync (leaf) and async (graph) paths. */
async function runWebpackLoader(resourcePath: string, source: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const context = {
      resourcePath,
      async: () => (error: Error | null, result?: string) => (error ? rejectPromise(error) : resolvePromise(result ?? "")),
      addDependency: () => {},
    };
    const sync = wgslWebpackLoader.call(context, source);
    if (typeof sync === "string") resolvePromise(sync);
  });
}

async function graphFixture(moduleSource: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-reserved-"));
  await writeFile(join(dir, "paint.wgsl"), moduleSource);
  await writeFile(join(dir, "entry.wgsl"), `import { paint } from "./paint.wgsl";\n@fragment fn main() -> @location(0) vec4f { return vec4f(paint()); }\n`);
  return dir;
}

const CLEAN_MODULE = "export struct Brush {\n  width: f32,\n}\nexport fn paint() -> f32 { return 1.0; }\n";
const RESERVED_MODULE = "export struct Brush {\n  interface: f32,\n}\nexport fn paint() -> f32 { return 1.0; }\n";

// `compile()` deliberately stays a passthrough. Running the reserved-identifier pass
// there pulls the full scanner into the browser-facing `@vgpu/wgsl` entry and exceeds
// its client bundle budget. Runtime WGSL strings are not built by a bundler and the
// driver reports the same error at createShaderModule, so the check is enforced on
// the build-time paths (`vgpu check`, resolveShader, and both loaders) instead.
test("compile() stays a byte-for-byte passthrough for runtime strings", () => {
  expect(compile(RESERVED_LEAF)).toMatchObject({ kind: "wgsl", wgsl: RESERVED_LEAF, diagnostics: [] });
  expect(compile(CLEAN_LEAF)).toMatchObject({ kind: "wgsl", wgsl: CLEAN_LEAF, diagnostics: [] });
});

test("vite loader fails the build on a reserved identifier in a leaf shader", async () => {
  await expect(transformWgsl(RESERVED_LEAF, "/paint.wgsl")).rejects.toMatchObject({ code: "VGPU-WGSL-RESERVED-IDENT" });
  await expect(transformWgsl(RESERVED_LEAF, "/paint.wgsl")).rejects.toThrow(/\/paint\.wgsl:2:3: 'from' is a reserved word in WGSL/);
});

test("webpack loader fails the build on a reserved identifier in a leaf shader", async () => {
  await expect(runWebpackLoader("/paint.wgsl", RESERVED_LEAF)).rejects.toMatchObject({ code: "VGPU-WGSL-RESERVED-IDENT" });
  await expect(runWebpackLoader("/paint.wgsl", RESERVED_LEAF)).rejects.toThrow(/\/paint\.wgsl:2:3: 'from' is a reserved word in WGSL/);
});

test("both loaders still emit clean leaf shaders", async () => {
  expect((await transformWgsl(CLEAN_LEAF, "/paint.wgsl")).code).toContain("wgsl");
  expect(await runWebpackLoader("/paint.wgsl", CLEAN_LEAF)).toContain("wgsl");
});

test("vite loader fails the build on a reserved identifier in an imported module", async () => {
  const dir = await graphFixture(RESERVED_MODULE);
  const entry = join(dir, "entry.wgsl");
  const source = `import { paint } from "./paint.wgsl";\n@fragment fn main() -> @location(0) vec4f { return vec4f(paint()); }\n`;
  await expect(transformWgsl({ source, id: entry })).rejects.toMatchObject({ code: "VGPU-WGSL-RESERVED-IDENT" });
  // The diagnostic points at the imported module, not at the entry.
  await expect(transformWgsl({ source, id: entry })).rejects.toThrow(new RegExp(`${join(dir, "paint.wgsl").replace(/[/\\]/g, "\\$&")}:2:3`));
});

test("webpack loader fails the build on a reserved identifier in an imported module", async () => {
  const dir = await graphFixture(RESERVED_MODULE);
  const source = `import { paint } from "./paint.wgsl";\n@fragment fn main() -> @location(0) vec4f { return vec4f(paint()); }\n`;
  await expect(runWebpackLoader(join(dir, "entry.wgsl"), source)).rejects.toMatchObject({ code: "VGPU-WGSL-RESERVED-IDENT" });
});

test("both loaders still emit clean graphs with imports", async () => {
  const dir = await graphFixture(CLEAN_MODULE);
  const source = `import { paint } from "./paint.wgsl";\n@fragment fn main() -> @location(0) vec4f { return vec4f(paint()); }\n`;
  expect((await transformWgsl({ source, id: join(dir, "entry.wgsl") })).code).toContain("paint");
  expect(await runWebpackLoader(join(dir, "entry.wgsl"), source)).toContain("paint");
});
