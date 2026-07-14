import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { transformWgsl } from "@vgpu/wgsl/loader-vite";
import wgslWebpackLoader from "@vgpu/wgsl/loader-webpack";

test("package exports pattern resolves", async () => {
  const dir = await pkgFixture({ exports: { "./shaders/*": "./dist/*.wgsl" }, files: { "dist/foo.wgsl": "export fn x(){}" } });
  await writeFile(join(dir, "app", "main.wgsl"), "import { x } from 'pkg/shaders/foo'; fn main(){x();}");
  expect((await resolveShader({ entry: join(dir, "app", "main.wgsl"), validate: false })).wgsl).toContain("dist/foo.wgsl");
});
test("walking stops at workspace root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  await mkdir(join(dir, "root", "app"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "root", "pnpm-workspace.yaml"), "packages: []");
  await writeFile(join(dir, "root", "app", "main.wgsl"), "import { x } from 'pkg';");
  await writeFile(join(dir, "node_modules", "pkg", "package.json"), JSON.stringify({ exports: { ".": "./index.wgsl" } }));
  await writeFile(join(dir, "node_modules", "pkg", "index.wgsl"), "export fn x(){}");
  await expect(resolveShader({ entry: join(dir, "root", "app", "main.wgsl"), validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-PKG-NOTFOUND" });
});
test("conditional exports select default", async () => {
  const dir = await pkgFixture({ exports: { ".": { import: "./bad.wgsl", default: "./good.wgsl" } }, files: { "good.wgsl": "export fn x(){}" } });
  await writeFile(join(dir, "app", "main.wgsl"), "import { x } from 'pkg'; fn main(){x();}");
  const result = await resolveShader({ entry: join(dir, "app", "main.wgsl"), validate: false });
  expect(result.wgsl).toContain("good.wgsl");
  expect(result.diagnostics).toEqual([expect.objectContaining({ code: "VGPU-WGSL-PKG-CONDITIONAL", severity: "warning" })]);
});
test("leaf loader path is byte-for-byte unchanged when minify is false", async () => {
  const source = "// import { x } from 'y'\n@compute @workgroup_size(1) fn main() {\n  var value = 1u;\n}\n";
  expect(defaultExport(await transformWgsl(source, "/x.wgsl"))).toBe(source);
  expect(defaultExport(wgslWebpackLoader.call({ resourcePath: "/x.wgsl" }, source) ?? "")).toBe(source);
});

test("leaf loader path compacts comments whitespace and safe locals when minify is true", async () => {
  const source = "// leading comment\n@compute @workgroup_size(1) fn main() {\n  /* keep names stable */ var value = 1u;\n}\n";
  const expected = "@compute @workgroup_size(1) fn main(){var a=1u;}";
  expect(defaultExport(await transformWgsl(source, "/x.wgsl", { minify: true }))).toBe(expected);
  expect(defaultExport(wgslWebpackLoader.call({ resourcePath: "/x.wgsl", getOptions: () => ({ minify: true }) }, source) ?? "")).toBe(expected);
});

test("leaf loader path supports object-form whitespace-only minify", async () => {
  const source = "// leading comment\n@compute @workgroup_size(1) fn main() {\n  /* keep names stable */ var value = 1u;\n}\n";
  const expected = "@compute @workgroup_size(1) fn main(){var value=1u;}";
  const minify = { identifiers: "none" } as const;
  expect(defaultExport(await transformWgsl(source, "/x.wgsl", { minify }))).toBe(expected);
  expect(defaultExport(wgslWebpackLoader.call({ resourcePath: "/x.wgsl", getOptions: () => ({ minify }) }, source) ?? "")).toBe(expected);
});

test("loader comment-only import passes through", async () => {
  const code = (await transformWgsl("// import { x } from 'y'", "/x.wgsl")).code;
  expect(code).toContain("version: 1");
  expect(code).toContain("// import");
});
test("loaders resolve top-level import", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  await writeFile(join(dir, "main.wgsl"), "import { x } from './x.wgsl'; fn main(){x();}");
  await writeFile(join(dir, "x.wgsl"), "export fn x(){}");
  expect((await transformWgsl(await readFile(join(dir, "main.wgsl"), "utf8"), join(dir, "main.wgsl"))).code).toContain("_vgsl_");
  const code = await webpack(join(dir, "main.wgsl"), await readFile(join(dir, "main.wgsl"), "utf8"));
  expect(code).toContain("_vgsl_");
});

test("loaders resolve imports after top-level diagnostic directives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  const entry = join(dir, "main.wgsl");
  await writeFile(entry, "diagnostic(off, derivative_uniformity);\nimport { x } from './x.wgsl';\nfn main(){x();}");
  await writeFile(join(dir, "x.wgsl"), "export fn x(){}");
  expect(defaultExport(await transformWgsl(await readFile(entry, "utf8"), entry))).toContain("_vgsl_");
  expect(defaultExport(await webpack(entry, await readFile(entry, "utf8")))).toContain("_vgsl_");
});

test("loaders compact resolved import graphs when minify is true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  const entry = join(dir, "main.wgsl");
  await writeFile(entry, "import { helper } from './helper.wgsl';\n// entry comment\nfn main(){ helper(); }\n");
  await writeFile(join(dir, "helper.wgsl"), "// helper comment\nexport fn helper(){ }\n");
  const viteWgsl = defaultExport(await transformWgsl(await readFile(entry, "utf8"), entry, { minify: true }));
  expect(viteWgsl).toBe("fn a(){b();}fn b(){}");
  expect(viteWgsl).not.toContain("//");
  expect(viteWgsl).not.toContain("\n");
  const webpackWgsl = defaultExport(await webpack(entry, await readFile(entry, "utf8"), { minify: true }));
  expect(webpackWgsl).toBe(viteWgsl);
});

test("loaders compact resolved import graphs with object-form minify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  const entry = join(dir, "main.wgsl");
  await writeFile(entry, "import { helper } from './helper.wgsl';\n// entry comment\nfn main(){ helper(); }\n");
  await writeFile(join(dir, "helper.wgsl"), "// helper comment\nexport fn helper(){ }\n");
  const minify = { whitespace: true, identifiers: "none" } as const;
  const viteWgsl = defaultExport(await transformWgsl(await readFile(entry, "utf8"), entry, { minify }));
  expect(viteWgsl).toContain("fn _vgsl_");
  expect(viteWgsl).toContain("__main(){_vgsl_");
  expect(viteWgsl).not.toContain("//");
  expect(viteWgsl).not.toContain("\n");
  const webpackWgsl = defaultExport(await webpack(entry, await readFile(entry, "utf8"), { minify }));
  expect(webpackWgsl).toBe(viteWgsl);
});

async function pkgFixture(opts: { exports: unknown; files: Record<string, string> }) {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  await mkdir(join(dir, "app"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "node_modules", "pkg", "package.json"), JSON.stringify({ exports: opts.exports }));
  for (const [file, text] of Object.entries(opts.files)) {
    await mkdir(join(dir, "node_modules", "pkg", file.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", file), text);
  }
  return dir;
}

function defaultExport(codeOrResult: string | { readonly code: string }): string {
  return shaderSource(codeOrResult).wgsl;
}

function shaderSource(codeOrResult: string | { readonly code: string }): { readonly version: 1; readonly wgsl: string } {
  const code = typeof codeOrResult === "string" ? codeOrResult : codeOrResult.code;
  return Function(code.replace(/^export default /, "return ").replace(/;$/, ";"))() as { readonly version: 1; readonly wgsl: string };
}

async function webpack(resourcePath: string, source: string, options: { readonly minify?: boolean | { readonly whitespace?: boolean; readonly identifiers?: "none" | "safe" } } = {}) {
  return new Promise<string>((resolve, reject) => wgslWebpackLoader.call({ resourcePath, getOptions: () => options, async: () => (error, result) => error ? reject(error) : resolve(result ?? "") }, source));
}
