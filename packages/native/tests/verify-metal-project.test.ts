import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import { loadMetalProject } from "../src/tooling/project.ts";
import {
  createMetalOutputRecord,
  metalOutputRecordPath,
} from "../src/tooling/output-record.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { verifyMetalOutput } from "../src/tooling/output-verification.ts";
import { fingerprintMetalProject } from "../src/tooling/fingerprint.ts";
import { metalGenerationProfile } from "../src/compatibility.ts";
import {
  projectConfiguration,
  projectFixture,
} from "./project-operation-fixture.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

test("an owned intact package verifies against the documented current project without tools or output writes", async () => {
  const input = await generatedFixture();
  const environment = {
    PATH: process.env.PATH,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
  };
  try {
    process.env.PATH = "";
    process.env.DEVELOPER_DIR = join(
      input.directory,
      "missing-apple-toolchain"
    );
    const before = await observeOutput(input.outputPath);
    const verified = await verifyMetalProject({
      configurationPath: input.configurationPath,
    });
    expect(verified).toEqual({
      configurationPath: input.configurationPath,
      outputPath: input.outputPath,
      moduleName: "AppShaders",
      inputFingerprint: input.fingerprint,
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("an imported source change reports stale output separately and leaves the intact owned package unchanged", async () => {
  const input = await generatedFixture();
  try {
    const helper = join(input.directory, "shaders/dimensions.wgsl");
    await writeFile(
      helper,
      `${await readFile(
        helper,
        "utf8"
      )}\n// Changed imported source, same shader behavior.`
    );
    const before = await observeOutput(input.outputPath);
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({
      name: "MetalProjectVerificationError",
      code: "stale-output",
      outputPath: input.outputPath,
      message: expect.stringMatching(/build/iu),
    });
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("an old module remains owned but cannot verify as a newly named module even with an inconsistent matching fingerprint", async () => {
  const input = await generatedFixture();
  try {
    await writeFile(
      input.configurationPath,
      JSON.stringify({ ...projectConfiguration, moduleName: "RenamedShaders" })
    );
    expect((await verifyMetalOutput(input)).moduleName).toBe("AppShaders");
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({ code: "stale-output" });
    const current = await loadMetalProject({
      configurationPath: input.configurationPath,
    });
    const path = join(input.outputPath, metalOutputRecordPath);
    const inconsistent = JSON.parse(await readFile(path, "utf8"));
    inconsistent.inputFingerprint = current.inputFingerprint;
    await writeFile(path, JSON.stringify(inconsistent));
    const before = await observeOutput(input.outputPath);
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({ code: "stale-output" });
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a package recorded for another generation profile is stale without comparing installed tool versions", async () => {
  const input = await generatedFixture();
  try {
    const current = await loadMetalProject({
      configurationPath: input.configurationPath,
    });
    const path = join(input.outputPath, metalOutputRecordPath);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.inputFingerprint = fingerprintMetalProject(current.compilerInput, {
      ...metalGenerationProfile,
      revision: metalGenerationProfile.revision + 1,
    });
    await writeFile(path, JSON.stringify(record));
    const before = await observeOutput(input.outputPath);
    expect((await verifyMetalOutput(input)).moduleName).toBe("AppShaders");
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({ code: "stale-output" });
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("foreign ownership remains an ownership diagnostic rather than being mistaken for stale output", async () => {
  const input = await generatedFixture();
  try {
    const foreign = join(input.directory, "foreign.json");
    await writeFile(
      foreign,
      JSON.stringify({ ...projectConfiguration, moduleName: "OtherShaders" })
    );
    const before = await observeOutput(input.outputPath);
    await expect(
      verifyMetalProject({ configurationPath: foreign })
    ).rejects.toMatchObject({
      name: "MetalOutputVerificationError",
      code: "output-owner-mismatch",
    });
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("modified or extra output remains an integrity diagnostic even when the source fingerprint is also stale", async () => {
  for (const change of ["library", "swift", "extra"] as const) {
    const input = await generatedFixture();
    try {
      await writeFile(
        join(input.directory, "shaders/dimensions.wgsl"),
        "export const width: u32 = 3u;"
      );
      if (change === "library")
        await writeFile(
          join(
            input.outputPath,
            "Sources/AppShaders/Resources/Shaders.metallib"
          ),
          new Uint8Array([3, 2, 1])
        );
      if (change === "swift")
        await writeFile(
          join(input.outputPath, "Sources/AppShaders/Shaders.generated.swift"),
          "// User changed output"
        );
      if (change === "extra") await mkdir(join(input.outputPath, ".build"));
      const before = await observeOutput(input.outputPath);
      await expect(
        verifyMetalProject({ configurationPath: input.configurationPath })
      ).rejects.toMatchObject({
        name: "MetalOutputVerificationError",
        code: "invalid-output",
      });
      expect(await observeOutput(input.outputPath)).toEqual(before);
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  }
});

test("verify owns caller options and compares the same capture after source and configuration files change", async () => {
  const input = await generatedFixture();
  try {
    const before = await observeOutput(input.outputPath);
    const dependencies: string[] = [];
    const options = {
      configurationPath: input.configurationPath,
      signal: new AbortController().signal,
      onDependency(path: string) {
        dependencies.push(path);
        unlinkSync(join(input.directory, "shaders/count.wgsl"));
        writeFileSync(
          input.configurationPath,
          "{changed after configuration capture"
        );
      },
    };
    const pending = verifyMetalProject(options);
    options.configurationPath = join(input.directory, "foreign.json");
    options.signal = AbortSignal.abort();
    options.onDependency = () => {
      throw new Error("Replaced callback must not run");
    };
    expect((await pending).inputFingerprint).toBe(input.fingerprint);
    expect(dependencies).toEqual([
      join(input.directory, "shaders/dimensions.wgsl"),
    ]);
    expect(await observeOutput(input.outputPath)).toEqual(before);
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({
      name: "MetalConfigurationError",
      code: "invalid-configuration",
    });
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancelling after capture reaches the real output reader and leaves every artifact unchanged", async () => {
  const input = await generatedFixture();
  const controller = new AbortController();
  const record = join(input.outputPath, metalOutputRecordPath);
  const originalOpen = filesystem.open;
  const before = await observeOutput(input.outputPath);
  // Synchronize at the filesystem boundary, using a real opened file handle.
  // No internal project/verification collaborator is replaced.
  const opening = vi
    .spyOn(filesystem, "open")
    .mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === record)
        controller.abort(new Error("Cancel record inspection"));
      return handle;
    });
  try {
    await expect(
      verifyMetalProject({
        configurationPath: input.configurationPath,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      name: "MetalOutputVerificationError",
      code: "cancelled",
    });
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    opening.mockRestore();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancelling before or during project capture preserves the original abort reason and existing output", async () => {
  const input = await generatedFixture();
  try {
    const before = await observeOutput(input.outputPath);
    for (const phase of ["before", "capture"] as const) {
      const controller = new AbortController();
      const reason = new Error(`Cancelled ${phase}`);
      if (phase === "before") controller.abort(reason);
      await expect(
        verifyMetalProject({
          configurationPath:
            phase === "before"
              ? join(input.directory, "missing.json")
              : input.configurationPath,
          signal: controller.signal,
          onDependency() {
            controller.abort(reason);
          },
        })
      ).rejects.toBe(reason);
    }
    expect(await observeOutput(input.outputPath)).toEqual(before);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("verify reports missing output without creating a generated directory", async () => {
  const input = await projectFixture();
  try {
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({
      name: "MetalOutputVerificationError",
      code: "invalid-output",
    });
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("an authored symlink or file hidden by parent traversal is an unsafe destination even when the simplified package is intact", async () => {
  for (const kind of ["symlink", "file"] as const) {
    const input = await generatedFixture();
    try {
      const component = join(input.directory, "Hidden");
      if (kind === "symlink") await symlink(input.outputPath, component);
      else await writeFile(component, "Keep this file");
      await writeFile(
        input.configurationPath,
        JSON.stringify({
          ...projectConfiguration,
          output: "Hidden/../Generated/AppShaders",
        })
      );
      expect((await verifyMetalOutput(input)).inputFingerprint).toBe(
        input.fingerprint
      );
      const before = await observeOutput(input.outputPath);
      await expect(
        verifyMetalProject({ configurationPath: input.configurationPath })
      ).rejects.toMatchObject({
        name: "MetalOutputBoundaryError",
        code: "unsafe-output",
        outputPath: input.outputPath,
      });
      expect(await observeOutput(input.outputPath)).toEqual(before);
      if (kind === "file")
        expect(await readFile(component, "utf8")).toBe("Keep this file");
      else expect(await filesystem.readlink(component)).toBe(input.outputPath);
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  }
});

test("safe original parent traversal verifies the same package without creating missing path components", async () => {
  const input = await generatedFixture();
  try {
    await writeFile(
      input.configurationPath,
      JSON.stringify({
        ...projectConfiguration,
        output: "Missing/../Generated/./AppShaders",
      })
    );
    const before = await observeOutput(input.outputPath);
    const verified = await verifyMetalProject({
      configurationPath: input.configurationPath,
    });
    expect(verified.outputPath).toBe(input.outputPath);
    expect(verified.inputFingerprint).toBe(input.fingerprint);
    expect(await observeOutput(input.outputPath)).toEqual(before);
    expect(await readdir(input.directory)).toEqual([
      "Generated",
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

async function generatedFixture() {
  const input = await projectFixture();
  const project = await loadMetalProject({
    configurationPath: input.configurationPath,
  });
  const generated = generateMetalPackage({
    moduleName: project.configuration.moduleName,
    programs: project.configuration.programs.map((program) => ({
      name: program.name,
      functions: program.entryPoints,
    })),
    // Artifact consistency fixture, not evidence of compilation or GPU execution.
    library: new Uint8Array([1, 2, 3]),
  });
  const files = {
    ...generated.files,
    [metalOutputRecordPath]: createMetalOutputRecord({
      moduleName: project.configuration.moduleName,
      ownerConfiguration: relative(input.outputPath, input.configurationPath),
      inputFingerprint: project.inputFingerprint,
      files: generated.files,
    }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(input.outputPath, path)), { recursive: true });
    await writeFile(join(input.outputPath, path), bytes);
  }
  return { ...input, fingerprint: project.inputFingerprint };
}

async function observeOutput(outputPath: string) {
  const observations = [];
  for (const path of (await readdir(outputPath, { recursive: true })).sort()) {
    const absolute = join(outputPath, path);
    const info = await stat(absolute, { bigint: true });
    observations.push({
      path,
      ino: info.ino,
      mtime: info.mtimeNs,
      ctime: info.ctimeNs,
      bytes: info.isFile() ? await readFile(absolute) : undefined,
    });
  }
  return observations;
}
