import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  checkMetalPackage,
  compileMetalPackage,
  type CompileMetalPackageInput,
} from "../src/compile.ts";

const base = {
  moduleName: "AppShaders",
  programs: [
    {
      name: "Count",
      source: "main.wgsl",
      entryPoints: { compute: "count_main" },
    },
  ],
  workerPath: "/missing/worker",
};

test("check and build reject ambiguous or absent source representations before source or compiler work", async () => {
  for (const compiler of [checkMetalPackage, compileMetalPackage]) {
    for (const input of [
      base,
      { ...base, modules: {}, snapshot: {} },
      { ...base, modules: {}, snapshot: undefined },
    ]) {
      await expect(
        compiler(input as CompileMetalPackageInput)
      ).rejects.toMatchObject({
        stage: "validation",
        message: expect.stringContaining("exactly one of modules or snapshot"),
      });
    }
  }
});

test("native snapshot inputs retain WGSL's strict data boundary without invoking accessors", async () => {
  const source = "@compute @workgroup_size(1) fn count_main() {}";
  const module = { source, imports: {} };
  let invoked = false;
  Object.defineProperty(module, "source", {
    enumerable: true,
    get() {
      invoked = true;
      return source;
    },
  });
  const snapshot = {
    schemaVersion: 1 as const,
    entries: { Count: "modules/0000.wgsl" },
    modules: { "modules/0000.wgsl": module },
    inputs: [
      {
        module: "modules/0000.wgsl",
        physicalPath: "/unused",
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ],
  };
  await expect(
    checkMetalPackage({
      ...base,
      programs: [{ ...base.programs[0], source: snapshot.entries.Count }],
      snapshot,
    })
  ).rejects.toMatchObject({ stage: "source", cause: expect.any(TypeError) });
  expect(invoked).toBe(false);
});

test("malformed snapshot hashes and graph edges fail at source for both check and build", async () => {
  const source = "@compute @workgroup_size(1) fn count_main() {}";
  const snapshot = {
    schemaVersion: 1,
    entries: { Count: "modules/0000.wgsl" },
    modules: { "modules/0000.wgsl": { source, imports: {} } },
    inputs: [
      {
        module: "modules/0000.wgsl",
        physicalPath: "/not/consulted",
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ],
  };
  const mutations: ((input: any) => void)[] = [
    (s) => {
      s.schemaVersion = 2;
    },
    (s) => {
      s.inputs[0].sha256 = "0".repeat(64);
    },
    (s) => {
      s.modules[s.entries.Count].imports["./extra.wgsl"] = s.entries.Count;
    },
    (s) => {
      const module = s.modules[s.entries.Count];
      module.source = 'import { missing } from "./missing.wgsl";\n' + source;
      s.inputs[0].sha256 = createHash("sha256")
        .update(module.source)
        .digest("hex");
    },
    (s) => {
      s.modules["modules/0001.wgsl"] = { source: "", imports: {} };
      s.inputs.push({
        module: "modules/0001.wgsl",
        physicalPath: "/not/consulted",
        sha256: createHash("sha256").update("").digest("hex"),
      });
    },
  ];
  for (const compiler of [checkMetalPackage, compileMetalPackage]) {
    for (const mutate of mutations) {
      const clone = JSON.parse(JSON.stringify(snapshot));
      mutate(clone);
      await expect(
        compiler({
          ...base,
          programs: [{ ...base.programs[0], source: snapshot.entries.Count }],
          snapshot: clone,
        })
      ).rejects.toMatchObject({
        stage: "source",
        cause: expect.any(TypeError),
      });
    }
  }
});

test("an inherited snapshot cannot override an own explicit module map", async () => {
  const input = Object.assign(Object.create({ snapshot: {} }), {
    ...base,
    modules: { "main.wgsl": "\0" },
  });
  for (const compiler of [checkMetalPackage, compileMetalPackage]) {
    await expect(compiler(input)).rejects.toMatchObject({
      stage: "source",
      message: expect.stringContaining("well-formed WGSL text"),
    });
  }
});
