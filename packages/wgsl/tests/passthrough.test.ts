import { expect, test } from "vitest";
import { compile } from "../src/index.ts";

test("compile passes plain WGSL through", () => {
  const source = "@compute @workgroup_size(1) fn main() {}";

  expect(compile(source)).toMatchObject({ kind: "wgsl", wgsl: source, diagnostics: [] });
});

test("compile rejects runtime imports", () => {
  const act = () => compile('import { x } from "./x";');
  expect(act).toThrow(/Runtime WGSL/);
  expect(act).toThrow(expect.objectContaining({ code: "VGPU-WGSL-RUNTIME-IMPORT" }));
});
