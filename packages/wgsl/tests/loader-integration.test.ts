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
test("loader comment-only import passes through", async () => expect((await transformWgsl("// import { x } from 'y'", "/x.wgsl")).code).toContain("// import"));
test("loaders resolve top-level import", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  await writeFile(join(dir, "main.wgsl"), "import { x } from './x.wgsl'; fn main(){x();}");
  await writeFile(join(dir, "x.wgsl"), "export fn x(){}");
  expect((await transformWgsl(await readFile(join(dir, "main.wgsl"), "utf8"), join(dir, "main.wgsl"))).code).toContain("_vgsl_");
  const code = await webpack(join(dir, "main.wgsl"), await readFile(join(dir, "main.wgsl"), "utf8"));
  expect(code).toContain("_vgsl_");
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

async function webpack(resourcePath: string, source: string) {
  return new Promise<string>((resolve, reject) => wgslWebpackLoader.call({ resourcePath, async: () => (error, result) => error ? reject(error) : resolve(result ?? "") }, source));
}
