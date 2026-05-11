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

  it.todo("triggers re-compile when a transitively imported .wgsl changes (addDependency wiring)");
});

async function writeFixture(): Promise<{ entryJs: string; outDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-webpack-"));
  const outDir = join(dir, "dist");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(dir, "helper.wgsl"), "export fn helper_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }");
  await writeFile(join(dir, "entry.wgsl"), `import { helper_color } from "./helper.wgsl";
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(dir, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { entryJs: join(dir, "entry.js"), outDir };
}

function resolveWebpackLoader(): string {
  try {
    return require.resolve("@vgpu/wgsl/loader-webpack");
  } catch {
    // The package exposes an ESM-only `import` condition, so `require.resolve` cannot
    // see this subpath from Vitest's ESM tests. Fall back to the built loader while
    // still exercising the same code exported by `@vgpu/wgsl/loader-webpack`.
    return join(process.cwd(), "packages/wgsl/dist/loader-webpack/index.js");
  }
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
