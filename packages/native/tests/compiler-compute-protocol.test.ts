import { expect, test } from "vitest";
import {
  checkedTranslation,
  compilerIdentity,
  translationContract,
} from "../src/compiler/protocol.ts";

// Synthetic compiler responses test the checked wire boundary only. The separate
// compile-compute native suite supplies real WGSL-to-GPU execution evidence.
const entryPoint = {
  stage: "compute",
  wgsl: "count_main",
  metal: "vgpu_count",
};
const semanticInterface = { kind: "compute" as const, inputs: [], outputs: [] };
const workgroupSize = { x: 1, y: 1, z: 1 };
const mappings = [
  {
    group: 2,
    binding: 9,
    slots: [
      {
        mode: "direct" as const,
        resourceClass: "buffer" as const,
        component: "buffer" as const,
        index: 0,
        count: 1 as const,
      },
    ],
  },
];

function fixture() {
  return {
    schemaVersion: 1,
    contractId: translationContract,
    ok: true,
    compiler: compilerIdentity,
    diagnostics: [],
    result: {
      msl: "kernel void vgpu_count() {}",
      entryPoint,
      interface: { kind: "compute" },
      resolvedWorkgroupSize: { ...workgroupSize },
      bindings: structuredClone(mappings),
      internalBindings: [
        {
          role: "immediate-data",
          slots: [
            {
              mode: "direct",
              resourceClass: "buffer",
              component: "buffer",
              index: 30,
              count: 1,
            },
          ],
        },
      ],
      storageBufferSizeRegions: [
        { stage: "compute", immediateDataByteOffset: 4 },
      ],
    },
  };
}

function check(response: unknown, hasRuntimeStorage = true) {
  return checkedTranslation(response, entryPoint, semanticInterface, mappings, {
    workgroupSize,
    hasRuntimeStorage,
  });
}

test("compute translation must preserve the authenticated semantic workgroup dimensions", () => {
  expect(check(fixture()).entryPoint).toEqual(entryPoint);
  const changed = fixture();
  changed.result.resolvedWorkgroupSize.x = 2;
  expect(() => check(changed)).toThrow(/workgroup size/);
});

test("compute size payloads require an effective canonical region for the selected stage and runtime storage", () => {
  expect(check(fixture()).internalData).toEqual([
    {
      kind: "storage-buffer-sizes",
      slot: { stage: "compute", index: 30 },
      immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1",
      storageBufferSizeModel:
        "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
      byteOffset: 4,
    },
  ]);
  const otherStage = fixture();
  otherStage.result.storageBufferSizeRegions[0].stage = "vertex";
  expect(() => check(otherStage)).toThrow(/internal data/);
  const immediateOnly = fixture();
  immediateOnly.result.storageBufferSizeRegions = [];
  expect(() => check(immediateOnly)).toThrow(/internal data/);
  expect(() => check(fixture(), false)).toThrow(/internal data/);
});

test("compute translation cannot change external mappings or introduce unknown internal roles", () => {
  const changedSlot = fixture();
  changedSlot.result.bindings[0].slots[0].index = 1;
  expect(() => check(changedSlot)).toThrow(/slots/);
  const changedCoordinate = fixture();
  changedCoordinate.result.bindings[0].group = 3;
  expect(() => check(changedCoordinate)).toThrow(/slots/);
  const unknownRole = fixture();
  unknownRole.result.internalBindings[0].role = "dispatch-state";
  expect(() => check(unknownRole)).toThrow(/Invalid Tint wire value/);
});

test("unused internal reservations do not create a compute payload", () => {
  const noEffectiveData = fixture();
  noEffectiveData.result.internalBindings = [];
  noEffectiveData.result.storageBufferSizeRegions = [];
  expect(check(noEffectiveData).internalData).toEqual([]);
  expect(check(noEffectiveData, false).internalData).toEqual([]);
});
