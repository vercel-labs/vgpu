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

  expect(output.schemaVersion).toBe(1);
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

test("vgpu check JSON carries per-entry bindings, sampling pairs and vertex inputs", async () => {
  const output = await runCheckSuccess(resolve(fixtureRoot, "sample.wgsl"));

  // schemaVersion 1 documents "the shader's reflection data as JSON"; before #252 the per-entry
  // metadata was non-enumerable and vanished from this payload without a trace.
  const entryPoints = output.reflection.entryPoints as { name: string; bindings?: unknown; samplingPairs?: unknown; inputs?: unknown }[];
  for (const entry of entryPoints) {
    expect(entry).toHaveProperty("bindings");
    expect(entry).toHaveProperty("samplingPairs");
    expect(Array.isArray(entry.bindings)).toBe(true);
  }

  const vertex = entryPoints.find((entry) => entry.name === "vs_main");
  expect(vertex?.inputs).toBeDefined();
  expect(entryPoints.find((entry) => entry.name === "fs_main")?.bindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ group: 0, binding: 0 })]),
  );
});

test("vgpu check surfaces Phase-1 fix-it text verbatim", async () => {
  const result = await runCheck([resolve(fixtureRoot, "bool-uniform.wgsl")]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBeUndefined();
  expect(result.stderr).toContain("VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE");
  expect(result.stderr).toContain("VGPUError: `bool` is not host-shareable in uniform/storage. Fix: use `u32` (0 | 1) → struct Params { enabled: u32 }");
});

test("vgpu check fails on WGSL reserved words used as identifiers", async () => {
  // The fixture is deliberately invalid WGSL, so with a WebGPU device present naga also rejects it.
  // Deliberately *not* pinning VGPU_VALIDATE: the JSON contract must be identical either way — the
  // reflection diagnostic is reported whether validation failed (device present) or was skipped
  // (no device), and only `validation` differs. Without that guarantee this assertion would pass in
  // CI and fail on a developer's GPU machine.
  const result = await runCheck([resolve(fixtureRoot, "reserved-word.wgsl")]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBeUndefined();
  const output = JSON.parse(result.stdout ?? "{}");
  expect(output.validation).toMatchObject({ attempted: true, ok: false });
  expect(output.reflection).toBeDefined();
  expect(output.diagnostics).toEqual([
    {
      code: "VGPU-WGSL-RESERVED-IDENT",
      message: "'from' is a reserved word in WGSL and cannot be used as an identifier; rename this struct member (for example 'from_')",
      severity: "error",
      line: 2,
      column: 3,
      range: { file: resolve(fixtureRoot, "reserved-word.wgsl"), start: { line: 2, column: 3 } },
    },
  ]);
});

test("vgpu check rejects imported modules that declare bindings", async () => {
  const result = await runCheck([resolve(fixtureRoot, "module-binding-entry.wgsl")]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBeUndefined();
  expect(result.stderr).toContain("VGPU-RESOLVE-MODULE-BINDING");
  expect(result.stderr).toContain("Modules cannot declare bindings — export the struct and declare it in your entry:\\n" +
    "  export struct NoiseConfig { seed: u32 }\\n" +
    "  // in your entry: @group(0) @binding(0) var<uniform> cfg: NoiseConfig;");
});
