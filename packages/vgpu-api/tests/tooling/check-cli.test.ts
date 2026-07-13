import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runCheck } from "../../../vgpu/lib/check/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "../fixtures");

async function runCheckSuccess(entry: string) {
  const result = await runCheck([entry]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBeUndefined();
  expect(result.stdout).toBeDefined();
  return JSON.parse(result.stdout ?? "{}");
}

test("vgpu check emits reflection JSON for WGSL files", async () => {
  const output = await runCheckSuccess(resolve(fixtureRoot, "sample.wgsl"));

  expect(output.entry).toBe(resolve(fixtureRoot, "sample.wgsl"));
  expect(output.reflection.bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        group: 0,
        binding: 0,
        name: "globals",
        kind: "buffer",
        layout: expect.objectContaining({ size: 16, align: 16 }),
      }),
    ]),
  );
  expect(output.reflection.entryPoints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "vs_main", stage: "vertex" }),
      expect.objectContaining({ name: "fs_main", stage: "fragment" }),
    ]),
  );
});

test("vgpu check surfaces Phase-1 fix-it text verbatim", async () => {
  const result = await runCheck([resolve(fixtureRoot, "bool-uniform.wgsl")]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBeUndefined();
  expect(result.stderr).toContain("VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE");
  expect(result.stderr).toContain("VGPUError: `bool` no es host-shareable en uniform/storage. Fix: usá `u32` (0 | 1) → struct Params { enabled: u32 }");
});
