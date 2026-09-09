import { expect, test } from "vitest";
import { isShaderFunctionExport } from "@vgpu/wgsl";

test("accepts well-formed shader function export metadata with additive fields", () => {
  const value: unknown = {
    name: "surfaceColor",
    resolvedName: "a",
    parameterNames: ["position", "time"],
    producer: "third-party-loader",
  };

  expect(isShaderFunctionExport(value)).toBe(true);

  if (!isShaderFunctionExport(value)) throw new Error("expected valid metadata");
  expect(value.name).toBe("surfaceColor");
});

test("rejects malformed metadata shapes without throwing", () => {
  const malformed: unknown[] = [
    null,
    42,
    [],
    {},
    { name: 1, resolvedName: "a", parameterNames: [] },
    { name: "surfaceColor", resolvedName: 1, parameterNames: [] },
    { name: "surfaceColor", resolvedName: "a", parameterNames: null },
    { name: "surfaceColor", resolvedName: "a", parameterNames: ["position", 1] },
    { name: "surfaceColor", resolvedName: "a", parameterNames: Array(1) },
  ];

  expect(() => malformed.map(isShaderFunctionExport)).not.toThrow();
  expect(malformed.map(isShaderFunctionExport)).toEqual(
    malformed.map(() => false),
  );
});

test("accepts only valid ASCII WGSL declaration identifiers", () => {
  expect(isShaderFunctionExport({
    name: "vec4f",
    resolvedName: "length",
    parameterNames: ["position", "_private"],
  })).toBe(true);

  const invalidIdentifiers = [
    "",
    "9value",
    "hello-world",
    "café",
    "_",
    "__private",
    "fn",
    "class",
    "binding_array",
  ];

  for (const identifier of invalidIdentifiers) {
    expect(isShaderFunctionExport({
      name: identifier,
      resolvedName: "a",
      parameterNames: [],
    }), `name: ${identifier}`).toBe(false);
    expect(isShaderFunctionExport({
      name: "surfaceColor",
      resolvedName: identifier,
      parameterNames: [],
    }), `resolvedName: ${identifier}`).toBe(false);
    expect(isShaderFunctionExport({
      name: "surfaceColor",
      resolvedName: "a",
      parameterNames: [identifier],
    }), `parameterNames: ${identifier}`).toBe(false);
  }
});

test("rejects duplicate parameter names", () => {
  expect(isShaderFunctionExport({
    name: "surfaceColor",
    resolvedName: "a",
    parameterNames: ["position", "position"],
  })).toBe(false);
});

test("validates indexed parameter names instead of a custom iterator", () => {
  const parameterNames: unknown[] = [42];
  parameterNames[Symbol.iterator] = function* () {
    yield "position";
  };

  expect(isShaderFunctionExport({
    name: "surfaceColor",
    resolvedName: "a",
    parameterNames,
  })).toBe(false);
});

test("returns false when malformed objects throw during inspection", () => {
  const value = Object.defineProperty({}, "name", {
    get() {
      throw new Error("unreadable metadata");
    },
  });
  let result: boolean | undefined;

  expect(() => {
    result = isShaderFunctionExport(value);
  }).not.toThrow();
  expect(result).toBe(false);
});
