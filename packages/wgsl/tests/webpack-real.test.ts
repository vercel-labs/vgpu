import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(bundle).toContain("helper_color");
    expect(bundle).toContain("main_color");
    expect(bundle).toContain("return _vgsl_");
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
});

async function writeFixture(): Promise<{ entryJs: string; outDir: string; helperWgsl: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-webpack-"));
  const outDir = join(dir, "dist");
  const helperWgsl = join(dir, "helper.wgsl");
  await mkdir(outDir, { recursive: true });
  await writeFile(helperWgsl, "export fn helper_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }");
  await writeFile(join(dir, "entry.wgsl"), `import { helper_color } from "./helper.wgsl";
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(dir, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { entryJs: join(dir, "entry.js"), outDir, helperWgsl };
}

function resolveWebpackLoader(): string {
  return require.resolve("@vgpu/wgsl/loader-webpack");
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
