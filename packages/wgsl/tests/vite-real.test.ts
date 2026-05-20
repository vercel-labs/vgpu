import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wgslVitePlugin from "@vgpu/wgsl/loader-vite";
import { build, type InlineConfig } from "vite";
import { describe, expect, it, vi } from "vitest";

describe("wgslVitePlugin (real vite 5)", () => {
  it("transforms .wgsl imports through wgslVitePlugin", async () => {
    const { root, entryJs } = await writeFixture();
    const config: InlineConfig = {
      root,
      logLevel: "silent",
      plugins: [wgslVitePlugin()],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryJs, formats: ["es"], fileName: "out" },
      },
    };

    const result = await build(config);
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs.flatMap((output) => output.output)
      .filter((chunk) => chunk.type === "chunk")
      .map((chunk) => chunk.code)
      .join("\n");

    expect(code).toContain("helper_color");
    expect(code).toContain("main_color");
    expect(code).toContain("return _vgsl_");
  });

  it("honors the minify plugin option in a real vite build", async () => {
    const { root, entryJs } = await writeFixture();
    const config: InlineConfig = {
      root,
      logLevel: "silent",
      plugins: [wgslVitePlugin({ minify: true })],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryJs, formats: ["es"], fileName: "out" },
      },
    };

    const result = await build(config);
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs.flatMap((output) => output.output)
      .filter((chunk) => chunk.type === "chunk")
      .map((chunk) => chunk.code)
      .join("\n");

    expect(code).toContain("helper_color");
    expect(code).toContain("return _vgsl_");
    expect(code).not.toContain("helper comment");
    expect(code).not.toContain("entry comment");
  });

  it("triggers re-compile via addWatchFile when a transitively imported .wgsl changes", async () => {
    const { entryWgsl, helperWgsl } = await writeFixture();
    const plugin = wgslVitePlugin();
    const addWatchFile = vi.fn();

    await plugin.transform.call({ addWatchFile }, await readFile(entryWgsl, "utf8"), entryWgsl);

    expect(addWatchFile).toHaveBeenCalledWith(helperWgsl);
    expect(addWatchFile).not.toHaveBeenCalledWith(entryWgsl);
  });
});

async function writeFixture(): Promise<{ root: string; entryJs: string; entryWgsl: string; helperWgsl: string }> {
  const root = await mkdtemp(join(tmpdir(), "vgsl-vite-"));
  const entryWgsl = join(root, "entry.wgsl");
  const helperWgsl = join(root, "helper.wgsl");
  await writeFile(helperWgsl, "// helper comment\nexport fn helper_color() -> vec4f { return vec4f(0.4, 0.5, 0.6, 1.0); }");
  await writeFile(entryWgsl, `import { helper_color } from "./helper.wgsl";
// entry comment
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(root, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { root, entryJs: join(root, "entry.js"), entryWgsl, helperWgsl };
}
