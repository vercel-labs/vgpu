import { prepareShader } from "@vgpu/wgsl/prepare";
import { afterAll, describe, expect, test } from "vitest";
import { evaluateShaderModule } from "../../wgsl/tests/helpers/evaluate-shader-module.ts";
import { shaderSourceModule } from "../../wgsl/src/loader-shared/emit.ts";
import type { ShaderSource } from "../../wgsl/src/types.ts";
import { drawReflection } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { compute, draw, effect, init } from "../src/mock.ts";

const DIAGNOSTIC_PATH = "/fixtures/packed-shader-source.wgsl";
const PACKED_SOURCE = largeShaderSource();
const PREPARED = prepareShader({ wgsl: PACKED_SOURCE, functionExports: [] }, DIAGNOSTIC_PATH);
const EMITTED = shaderSourceModule(PACKED_SOURCE, DIAGNOSTIC_PATH, []);

afterAll(() => {
  // Keep failures readable if the selector changes: this fixture is intentionally large enough
  // to exercise normal selection, never a test-only force-packing path.
  expect(Buffer.byteLength(JSON.stringify(PREPARED.reflection))).toBeGreaterThanOrEqual(32 * 1024);
});

describe("loader-emitted packed ShaderSource acceptance", () => {
  test("the naturally large fixture selects packed metadata", () => {
    expect(EMITTED).toContain("decodePackedMetadata");
    expect(EMITTED).toContain("__vgpu_packed_v1=");
  });

  test("evaluation reconstructs the exact public v2 value for the original diagnostic path", async () => {
    const actual = await evaluateShaderModule(EMITTED);

    expect(actual).toStrictEqual(PREPARED);
    expect(Object.keys(actual)).toEqual([
      "version",
      "wgsl",
      "reflection",
      "sourceChecksum",
      "producer",
      "functionExports",
    ]);
    expect(actual.reflection.entryPoints.find((entry) => entry.stage === "compute")?.workgroupSize)
      .toEqual(["unresolved", 2, 1]);
    expect(actual.reflection.entryPoints.map((entry) => entry.stage).sort())
      .toEqual(["compute", "fragment", "vertex"]);
    expect(actual.functionExports).toEqual([]);
    expect(JSON.parse(JSON.stringify(actual))).toStrictEqual(actual);
    expect(structuredClone(actual)).toStrictEqual(actual);
  });

  test("separate artifacts and equal decoded records stay distinct, frozen and independently copyable", async () => {
    const first = await evaluateShaderModule(EMITTED);
    const second = await evaluateShaderModule(EMITTED);
    const duplicates = findEqualObjectPair(first.reflection);

    expect(first).not.toBe(second);
    expect(first.reflection).not.toBe(second.reflection);
    expect(duplicates).toBeDefined();
    expect(duplicates?.[0]).not.toBe(duplicates?.[1]);
    expect(Object.isFrozen(duplicates?.[0])).toBe(true);
    expect(() => { mutable(first).reflection.entryPoints[0]!.name = "mutated"; }).toThrow(TypeError);

    // Copies are the supported way to obtain mutable data; they never alias the frozen artifact.
    const copy = mutableCopy(first);
    const copiedDuplicates = findEqualObjectPair(copy.reflection);
    if (copiedDuplicates) {
      copiedDuplicates[0].testMutation = "first-only";
      expect(copiedDuplicates[1]).not.toHaveProperty("testMutation");
    }
    copy.reflection.entryPoints[0]!.name = "mutated";
    expect(first.reflection.entryPoints[0]?.name).not.toBe("mutated");
    expect(second.reflection.entryPoints[0]?.name).not.toBe("mutated");
  });

  test("draw, effect and compute consume the emitted artifact through the mock entry", async () => {
    const gpu = await init();
    try {
      const artifact = await evaluateShaderModule(EMITTED);
      expect(() => draw(gpu, {
        shader: artifact,
        entry: { vertex: "vs_main", fragment: "fs_main" },
        label: "packed-draw",
      })).not.toThrow();
      expect(() => effect(gpu, artifact, {
        entry: { fragment: "fs_main" },
        label: "packed-effect",
      })).not.toThrow();
      expect(() => compute(gpu, artifact, {
        entry: "cs_main",
        constants: { WG_SIZE: 1 },
        label: "packed-compute",
      })).not.toThrow();
    } finally {
      gpu.dispose();
    }
  });

  test("renderer snapshotting and public corruption diagnostics are unchanged", async () => {
    const gpu = await init();
    try {
      const artifact = mutableCopy(await evaluateShaderModule(EMITTED));
      const accepted = effect(gpu, artifact, { entry: { fragment: "fs_main" } });
      const snapshot = drawReflection(effectDraw(accepted));
      const originalName = artifact.reflection.entryPoints[0]?.name;
      artifact.reflection.entryPoints[0]!.name = "after-construction";
      expect(snapshot.entryPoints[0]?.name).toBe(originalName);
      expect(originalName).not.toBe("after-construction");

      const checksum = mutableCopy(await evaluateShaderModule(EMITTED));
      checksum.wgsl += "\n";
      expectCode(() => effect(gpu, checksum), "VGPU-SHADER-SOURCE-INVALID");

      const layout = mutableCopy(await evaluateShaderModule(EMITTED));
      layout.reflection.bindings[0]!.layout.size += 4;
      expectCode(() => draw(gpu, { shader: layout }), "VGPU-SHADER-SOURCE-INVALID");

      const sampling = mutableCopy(await evaluateShaderModule(EMITTED));
      const texture = sampling.reflection.bindings.find((binding) => binding.kind === "texture");
      if (!texture || texture.kind !== "texture") throw new Error("fixture lost its sampled texture binding");
      texture.bindingLayout.texture.sampleType = "malformed";
      expectCode(() => effect(gpu, sampling), "VGPU-SHADER-SOURCE-INVALID");
    } finally {
      gpu.dispose();
    }
  });
});

function largeShaderSource(): string {
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
  return `
struct RuntimeParams {
${members}
}
@group(0) @binding(0) var<uniform> params0: RuntimeParams;
@group(0) @binding(1) var<uniform> params1: RuntimeParams;
@group(0) @binding(2) var<uniform> params2: RuntimeParams;
@group(0) @binding(3) var<uniform> params3: RuntimeParams;
@group(0) @binding(4) var sourceTexture: texture_2d<f32>;
@group(0) @binding(5) var sourceSampler: sampler;
override WG_SIZE: u32 = 1;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(index), params0.m2.x, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return textureSample(sourceTexture, sourceSampler, vec2f(0.5)) + params1.m2;
}
@compute @workgroup_size(WG_SIZE, 2, 1) fn cs_main() {
  _ = params2.m0;
}
`;
}

function mutable(value: ShaderSource): MutableShaderSource {
  return value as MutableShaderSource;
}

function mutableCopy(value: ShaderSource): MutableShaderSource {
  return structuredClone(value) as MutableShaderSource;
}

type MutableShaderSource = {
  -readonly [K in keyof ShaderSource]: K extends "reflection" ? any : ShaderSource[K];
};

function findEqualObjectPair(root: unknown): [Record<string, unknown>, Record<string, unknown>] | undefined {
  const byValue = new Map<string, Record<string, unknown>>();
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length > 0 && visited++ < 20_000) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    const encoded = JSON.stringify(record);
    if (encoded.length >= 64 && encoded.length <= 4096) {
      const previous = byValue.get(encoded);
      if (previous) return [previous, record];
      byValue.set(encoded, record);
    }
    pending.push(...Object.values(record));
  }
  return undefined;
}

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ code }));
}
