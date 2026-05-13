import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import webpack, { type Configuration, type Stats } from "webpack";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("wgslWebpackLoader (real webpack 5)", () => {
  it("bundles a .wgsl file with imports through wgslWebpackLoader", async () => {
    const { entryJs, outDir } = await writeFixture();
    const bundleName = "bundle.cjs";

    await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    });

    const bundle = await readFile(join(outDir, bundleName), "utf8");
    expectBundleContainsResolvedWgsl(bundle);
  });

  it("resolves the loader via bare string 'package-name/loader-path'", async () => {
    const { dir, entryJs, outDir } = await writeFixture();
    await installWorkspacePackage(dir);
    const bundleName = "bundle.cjs";

    await runWebpack({
      mode: "development",
      target: "node",
      context: dir,
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: "@vgpu/wgsl/loader-webpack" }] },
      optimization: { minimize: false },
    });

    expectBundleContainsResolvedWgsl(await readFile(join(outDir, bundleName), "utf8"));
  });

  it("triggers re-compile when a transitively imported .wgsl changes (addDependency wiring)", async () => {
    const { entryJs, outDir, helperWgsl } = await writeFixture();
    const stats = await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: "bundle.cjs", libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    });

    expect(stats.compilation.fileDependencies.has(helperWgsl)).toBe(true);
  });

  it("emits fresh bundled WGSL when a transitive import changes between builds", async () => {
    const { entryJs, outDir, helperWgsl } = await writeFixture();
    const config: Configuration = {
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: "bundle.cjs", libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    };

    await runWebpack(config);
    const first = await readFile(join(outDir, "bundle.cjs"), "utf8");
    await writeFile(helperWgsl, "export fn helper_color() -> vec4f { return vec4f(0.9, 0.8, 0.7, 1.0); }");
    await runWebpack(config);
    const second = await readFile(join(outDir, "bundle.cjs"), "utf8");

    expect(first).toContain("0.1, 0.2, 0.3, 1.0");
    expect(second).not.toBe(first);
    expect(second).toContain("0.9, 0.8, 0.7, 1.0");
  });
});

async function writeFixture(): Promise<{ dir: string; entryJs: string; outDir: string; helperWgsl: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-webpack-"));
  const outDir = join(dir, "dist");
  const helperWgsl = join(dir, "helper.wgsl");
  await mkdir(outDir, { recursive: true });
  await writeFile(helperWgsl, "export fn helper_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }");
  await writeFile(join(dir, "entry.wgsl"), `import { helper_color } from "./helper.wgsl";
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(dir, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { dir, entryJs: join(dir, "entry.js"), outDir, helperWgsl };
}

async function installWorkspacePackage(dir: string): Promise<void> {
  const scopeDir = join(dir, "node_modules", "@vgpu");
  await mkdir(scopeDir, { recursive: true });
  await symlink(resolve("packages/wgsl"), join(scopeDir, "wgsl"), "dir");
}

function resolveWebpackLoader(): string {
  return require.resolve("@vgpu/wgsl/loader-webpack");
}

function expectBundleContainsResolvedWgsl(bundle: string): void {
  expect(bundle).toContain("helper_color");
  expect(bundle).toContain("main_color");
  expect(bundle).toContain("return _vgsl_");
}

function runWebpack(config: Configuration): Promise<Stats> {
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stats) {
        reject(new Error("webpack completed without stats"));
        return;
      }
      if (stats.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true, errorDetails: true })));
        return;
      }
      resolve(stats);
    });
  });
}
