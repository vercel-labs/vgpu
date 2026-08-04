import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

/**
 * The ships-today proof for the leading-dot float fix: `apps/docs/examples/fluid/divergence.wgsl`
 * and `project.wgsl` both contain `*.5*`, and every `minify: true` build of them used to emit
 * `*. 5*` — WGSL the device rejects with "unable to parse right side of * expression". These are the
 * real repository files, read from disk, so the test tracks the shaders as they actually ship.
 */
const fluidDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/docs/examples/fluid");
const hasDevice = process.env.VGPU_DOCKER_TEST === "1";

async function fluidModules(entryName: string): Promise<Record<string, string>> {
  return {
    [`/${entryName}`]: await readFile(resolve(fluidDir, entryName), "utf8"),
    "/fluid-common.wgsl": await readFile(resolve(fluidDir, "fluid-common.wgsl"), "utf8"),
  };
}

for (const entryName of ["divergence.wgsl", "project.wgsl"]) {
  test(`minify:true keeps the leading-dot floats in apps/docs/examples/fluid/${entryName}`, async () => {
    const modules = await fluidModules(entryName);
    // Guards against the fixture drifting away from the literal this test is about.
    expect(modules[`/${entryName}`]).toContain("*.5*");

    const result = await resolveShader({ entry: `/${entryName}`, modules, minify: true });
    expect(result.wgsl).not.toContain(". 5");
    expect((result.wgsl.match(/\*\.5\*/g) ?? []).length).toBe(2);
  });

  test.skipIf(!hasDevice)(`the real device accepts minified apps/docs/examples/fluid/${entryName}`, async () => {
    const result = await resolveShader({ entry: `/${entryName}`, modules: await fluidModules(entryName), minify: true, validate: "require" });
    expect(result.validation).toMatchObject({ mode: "require", attempted: true, ok: true });
  });
}
