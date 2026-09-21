import { expect, test } from "vitest";
import {
  checkMetalPackage,
  type CompileMetalPackageInput,
} from "../src/compile.ts";

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

test("check rejects malformed package identities before source or worker access", async () => {
  for (const malformed of [
    null,
    [],
    { ...input, moduleName: "Metal" },
    { ...input, programs: [] },
    { ...input, programs: [null] },
    { ...input, programs: [{ ...input.programs[0], name: "String" }] },
    {
      ...input,
      programs: [input.programs[0], { ...input.programs[0], name: "triangle" }],
    },
  ]) {
    await expect(
      checkMetalPackage(malformed as CompileMetalPackageInput)
    ).rejects.toMatchObject({
      stage: "validation",
      cause: expect.any(TypeError),
    });
  }
});

test("check rejects incomplete or mixed stage maps before source or worker access", async () => {
  for (const entryPoints of [
    undefined,
    {},
    { vertex: "vertex_main" },
    { compute: "compute_main", fragment: "fragment_main" },
    { compute: 1 },
  ]) {
    await expect(
      checkMetalPackage({
        ...input,
        programs: [{ ...input.programs[0], entryPoints }],
      } as CompileMetalPackageInput)
    ).rejects.toMatchObject({
      stage: "validation",
      message: expect.stringContaining("one vertex and one fragment"),
    });
  }
});

test("check keeps malformed source failures inside the explicit virtual module map", async () => {
  const cases: Record<string, string>[] = [
    {},
    { "main.wgsl": 'import { missing } from "./missing.wgsl";' },
    { "main.wgsl": "", "../outside.wgsl": "" },
    { "main.wgsl": "\uD800" },
  ];
  for (const modules of cases) {
    await expect(
      checkMetalPackage({ ...input, modules })
    ).rejects.toMatchObject({
      stage: "source",
    });
  }
});

test("a pre-aborted check cannot report success or start the missing worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    checkMetalPackage({ ...input, signal: controller.signal })
  ).rejects.toMatchObject({
    stage: "validation",
    cause: { code: "cancelled" },
  });
});
