import { expect, test } from "vitest";
import { reflectSource, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { VGPUError } from "../src/errors.ts";
import { bindGroupLayoutEntriesForGroup, visibilityForEntries } from "../src/set-layouts.ts";

// #252's shader, with `params` actually used so all three bindings are live.
const SHADER = `struct Params { time: f32, }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn sample_it(uv: vec2f) -> vec4f { return textureSample(tex, samp, uv); }

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return sample_it(uv) * params.time; }
`;

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("a JSON round-tripped reflection produces byte-identical bind group layout entries", () => {
  const reflection = reflectSource(SHADER, "issue-252.wgsl");
  const live = reflection.entryPoints;
  const serialized = roundTrip(reflection) as Reflection;

  const liveEntries = bindGroupLayoutEntriesForGroup(reflection.bindings, 0, visibilityForEntries(reflection.bindings, live));
  const serializedEntries = bindGroupLayoutEntriesForGroup(serialized.bindings, 0, visibilityForEntries(serialized.bindings, serialized.entryPoints));

  expect(serializedEntries).toEqual(liveEntries);
  // The filtering pair must survive: losing it downgrades the texture to "unfilterable-float",
  // which WebGPU then rejects when a filtering sampler is bound against this layout.
  expect(serializedEntries.find((entry) => entry.binding === 1)?.texture?.sampleType).toBe("float");
  // Visibility must stay fragment-only (2) rather than widening to every declared binding.
  expect(serializedEntries.map((entry) => [entry.binding, entry.visibility])).toEqual([[0, 2], [1, 2], [2, 2]]);
});

test("visibilityForEntries fails loudly when an entry point has no reflected bindings", () => {
  const [entry] = reflectSource(SHADER, "issue-252.wgsl").entryPoints;
  const stripped = { name: entry!.name, mangledName: entry!.mangledName, stage: entry!.stage } as EntryPointInfo;

  expect(() => visibilityForEntries([], [stripped])).toThrowError(VGPUError);
  expect(() => visibilityForEntries([], [stripped])).toThrowError(/has no reflected bindings/);
  try {
    visibilityForEntries([], [stripped]);
  } catch (error) {
    expect((error as VGPUError).code).toBe("VGPU-REFLECT-ENTRY-METADATA-MISSING");
  }
});

test("visibilityForEntries fails loudly when an entry point has no reflected samplingPairs", () => {
  const [entry] = reflectSource(SHADER, "issue-252.wgsl").entryPoints;
  const stripped = { name: entry!.name, mangledName: entry!.mangledName, stage: entry!.stage, bindings: entry!.bindings } as EntryPointInfo;

  expect(() => visibilityForEntries([], [stripped])).toThrowError(/has no reflected samplingPairs/);
});
