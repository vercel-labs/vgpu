import { expect, test } from "vitest";
import {
  compileMetalPackage,
  type CompileMetalPackageInput,
} from "../src/compile.ts";
import { generateMetalPackage } from "../src/index.ts";

const input: CompileMetalPackageInput = {
  moduleName: "AppShaders",
  programs: [
    {
      name: "Triangle",
      source: "main.wgsl",
      entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
    },
  ],
  modules: { "main.wgsl": "" },
  workerPath: "/missing/compiler",
};

test("generated packages accept compiler-qualified Metal function identities", () => {
  expect(() =>
    generateMetalPackage({
      moduleName: "AppShaders",
      library: new Uint8Array([1]),
      programs: [
        {
          name: "Triangle",
          functions: {
            vertex: "program_vertex::vgpu_selected_vertex",
            fragment: "program_fragment::vgpu_selected_fragment",
          },
        },
      ],
    })
  ).not.toThrow();
});

test("unsupported stage maps fail before source or compiler work", async () => {
  for (const entryPoints of [
    { vertex: "vertex_main" },
    { compute: "compute_main" },
    {
      vertex: "vertex_main",
      fragment: "fragment_main",
      compute: "compute_main",
    },
  ]) {
    await expect(
      compileMetalPackage({
        ...input,
        programs: [{ ...input.programs[0], entryPoints }],
      } as CompileMetalPackageInput)
    ).rejects.toThrow(/one vertex and one fragment/);
  }
});

test("invalid package identities fail before invoking a compiler", async () => {
  for (const variation of [
    { moduleName: "Metal" },
    { programs: [] },
    { programs: [{ ...input.programs[0], name: "String" }] },
    {
      programs: [input.programs[0], { ...input.programs[0], name: "triangle" }],
    },
  ]) {
    await expect(
      compileMetalPackage({ ...input, ...variation })
    ).rejects.toMatchObject({
      stage: "validation",
      cause: expect.any(TypeError),
    });
  }
});

test("source failures stay inside the explicit module map and retain their stage", async () => {
  const cases: Record<string, string>[] = [
    {},
    { "main.wgsl": 'import { missing } from "./missing.wgsl";' },
    { "main.wgsl": "", "../outside.wgsl": "" },
    { "main.wgsl": "\uD800" },
  ];
  for (const modules of cases) {
    await expect(
      compileMetalPackage({ ...input, modules })
    ).rejects.toMatchObject({ stage: "source" });
  }
});

test("cancelled compilation cannot return a generated package", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    compileMetalPackage({ ...input, signal: controller.signal })
  ).rejects.toMatchObject({
    stage: "validation",
    cause: { code: "cancelled" },
  });
});
