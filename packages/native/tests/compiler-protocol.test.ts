import { expect, test } from "vitest";
import {
  checkedSemanticResult,
  checkedTranslation,
  compilerIdentity,
  semanticContract,
  translationContract,
} from "../src/compiler/protocol.ts";

test("effective internal metadata cannot cross the resource-free translation boundary", () => {
  const entryPoint = {
    stage: "fragment",
    wgsl: "fragment_main",
    metal: "vgpu_emitted_fragment",
  };
  const semanticInterface = {
    kind: "fragment" as const,
    inputs: [],
    outputs: [
      { type: { scalar: "f32", width: 4 }, invariant: false, location: 0 },
    ],
  };
  const response = {
    schemaVersion: 1,
    contractId: translationContract,
    ok: true,
    compiler: compilerIdentity,
    diagnostics: [],
    result: {
      msl: "unconsumed transport fixture",
      entryPoint,
      interface: {
        kind: "fragment",
        colorOutputs: [{ semantic: { location: 0 }, metal: { color: 0 } }],
      },
      bindings: [],
      storageBufferSizeRegions: [],
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
    },
  };
  expect(() =>
    checkedTranslation(response, entryPoint, semanticInterface)
  ).toThrow(/internal data/);
});

test("a failed semantic response must match its request before its diagnostics are trusted", () => {
  const response = {
    schemaVersion: 1,
    contractId: semanticContract,
    compiler: compilerIdentity,
    ok: false,
    requestIdentity: {
      domain: "vgpu-native-tint-semantic-extraction-request-bytes/v1",
      sha256: "0".repeat(64),
    },
    diagnostics: [
      {
        severity: "error",
        code: "VGPU-NATIVE-WGSL-VALIDATE",
        phase: "wgsl",
        message: "untrusted unrelated diagnostic",
      },
    ],
  };
  expect(() =>
    checkedSemanticResult(response, "different request", [])
  ).toThrow(/another request/);
});

test("translation cannot claim an entry declaration present only in comments or literals", () => {
  const entryPoint = {
    stage: "fragment",
    wgsl: "fragment_main",
    metal: "vgpu_expected_fragment",
  };
  const semanticInterface = {
    kind: "fragment" as const,
    inputs: [],
    outputs: [
      { type: { scalar: "f32", width: 4 }, invariant: false, location: 0 },
    ],
  };
  for (const msl of [
    "fragment float4 different_fragment() { return float4(1); }",
    "/* fragment float4 vgpu_expected_fragment() {} */",
    'const char* decoy = "fragment float4 vgpu_expected_fragment() {}";',
  ]) {
    const response = {
      schemaVersion: 1,
      contractId: translationContract,
      ok: true,
      compiler: compilerIdentity,
      diagnostics: [],
      result: {
        msl,
        entryPoint,
        interface: {
          kind: "fragment",
          colorOutputs: [{ semantic: { location: 0 }, metal: { color: 0 } }],
        },
        bindings: [],
        internalBindings: [],
        storageBufferSizeRegions: [],
      },
    };
    expect(() =>
      checkedTranslation(response, entryPoint, semanticInterface)
    ).toThrow(/entry declaration/);
  }
});
