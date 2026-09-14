import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { copyShaderGraphSnapshot } from "../src/runtime/resolve-shader.ts";

function serialized() {
  const source = "@compute @workgroup_size(1) fn main() {}";
  return { schemaVersion: 1 as const, entries: { Main: "modules/0000.wgsl" }, modules: { "modules/0000.wgsl": { source, imports: {} } }, inputs: [{ module: "modules/0000.wgsl", physicalPath: "/informational", sha256: createHash("sha256").update(source).digest("hex") }] };
}

test("checked copying owns deterministic deeply frozen snapshot data synchronously", () => {
  const original = serialized();
  const expected = JSON.stringify(original);
  const copy = copyShaderGraphSnapshot(original);
  expect(copy).not.toBeInstanceOf(Promise);
  expect(JSON.stringify(copy)).toBe(expected);
  expect(copyShaderGraphSnapshot(JSON.parse(expected))).toEqual(copy);
  original.entries.Main = "changed";
  original.modules["modules/0000.wgsl"].source = "changed";
  original.inputs[0].physicalPath = "changed";
  expect(JSON.stringify(copy)).toBe(expected);
  for (const object of [copy, copy.entries, copy.modules, copy.modules["modules/0000.wgsl"], copy.modules["modules/0000.wgsl"].imports, copy.inputs, copy.inputs[0]]) expect(Object.isFrozen(object)).toBe(true);
});

test("checked copying rejects accessors and custom prototypes without invoking getters", () => {
  const input = serialized();
  let invoked = false;
  Object.defineProperty(input.modules["modules/0000.wgsl"], "source", { enumerable: true, get() { invoked = true; return ""; } });
  expect(() => copyShaderGraphSnapshot(input)).toThrow(TypeError);
  expect(invoked).toBe(false);
  expect(() => copyShaderGraphSnapshot(Object.assign(Object.create({ inherited: true }), serialized()))).toThrow(TypeError);
});
