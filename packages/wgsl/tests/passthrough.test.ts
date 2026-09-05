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

test("compile reports compute entry points behind their required attributes", () => {
  expect(compile("@compute @workgroup_size(1) fn main() {}").entryPoints).toEqual(["main"]);
  expect(compile("@compute\n@workgroup_size(8, 8)\nfn cs() {}").entryPoints).toEqual(["cs"]);
  expect(compile("@workgroup_size(1) @compute fn cs() {}").entryPoints).toEqual(["cs"]);
  expect(compile("@compute @workgroup_size(WG * ((N + 1))) fn cs() {}").entryPoints).toEqual(["cs"]);
});

test("compile does not run an entry point match into the next declaration", () => {
  expect(compile("@compute\nstruct S { x: f32 };\n@fragment fn fs() {}").entryPoints).toEqual(["fs"]);
  expect(compile("@compute @workgroup_size(1)").entryPoints).toEqual([]);
});

test("compile reports every stage of a multi-entry shader in source order", () => {
  const source = "@compute @workgroup_size(64) fn simulate() {}\n@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }";

  expect(compile(source).entryPoints).toEqual(["simulate", "vs", "fs"]);
});

test("compile does not truncate non-ASCII entry point names", () => {
  expect(compile("@fragment fn maín() -> @location(0) vec4f { return vec4f(1); }").entryPoints).toEqual(["maín"]);
  expect(compile("@fragment fn Ωmain() -> @location(0) vec4f { return vec4f(1); }").entryPoints).toEqual(["Ωmain"]);
});

test("compile ignores entry points inside comments", () => {
  const source = "// @vertex fn lineGhost() {}\n/* @compute @workgroup_size(1) fn blockGhost() {} */\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }";

  expect(compile(source).entryPoints).toEqual(["fs"]);
});
