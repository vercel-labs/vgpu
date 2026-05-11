import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wgslVitePlugin from "@vgpu/wgsl/loader-vite";
import { build, type InlineConfig } from "vite";
import { describe, expect, it } from "vitest";

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

  it.todo("triggers re-compile via addWatchFile when a transitively imported .wgsl changes");
});

async function writeFixture(): Promise<{ root: string; entryJs: string }> {
  const root = await mkdtemp(join(tmpdir(), "vgsl-vite-"));
  await writeFile(join(root, "helper.wgsl"), "export fn helper_color() -> vec4f { return vec4f(0.4, 0.5, 0.6, 1.0); }");
  await writeFile(join(root, "entry.wgsl"), `import { helper_color } from "./helper.wgsl";
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(root, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { root, entryJs: join(root, "entry.js") };
}
