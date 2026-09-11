import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { inspect, promisify } from "node:util";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { expect, test, vi, type MockInstance } from "vitest";
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import {
  parseMetalOutputRecord,
  metalOutputRecordPath,
} from "../src/tooling/output-record.ts";
import {
  projectConfiguration,
  projectFixture,
} from "./project-operation-fixture.ts";
import { runConsumer } from "./native-support.ts";
import { loadMetalProject } from "../src/tooling/project.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);
const guide = await readFile(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-dispatch.docs.md",
    import.meta.url
  ),
  "utf8"
);
const swift = [...guide.matchAll(/```swift\n([\s\S]*?)\n```/gu)].map(
  (match) => match[1]
);

test("one documented project prepares a coherent four-file package consumed by real Swift and Metal without publishing output", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    expect(prepared.project.filePath).toBe(input.configurationPath);
    expect(Object.keys(prepared.files).sort()).toEqual(
      [
        metalOutputRecordPath,
        "Package.swift",
        "Sources/AppShaders/Resources/Shaders.metallib",
        "Sources/AppShaders/Shaders.generated.swift",
      ].sort()
    );
    const record = parseMetalOutputRecord(
      prepared.files[metalOutputRecordPath]
    );
    expect(prepared.record).toEqual(record);
    expect(record.moduleName).toBe("AppShaders");
    expect(record.ownerConfiguration).toBe("../../vgpu.native.json");
    expect(record.inputFingerprint).toBe(prepared.project.inputFingerprint);
    for (const file of record.files) {
      expect(
        createHash("sha256").update(prepared.files[file.path]).digest("hex")
      ).toBe(file.sha256);
    }
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.files)).toBe(true);
    expect(Object.isFrozen(prepared.record)).toBe(true);
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
    expect(await executeCount(prepared.files)).toEqual([100, 101]);
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("preparation owns the explicit tool environment before project awaits and uses it for both worker and Metal scratch", async () => {
  const input = await projectFixture();
  const previous = {
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  try {
    const selected = (
      await promisify(execFile)("/usr/bin/xcode-select", ["--print-path"], {
        timeout: 10_000,
      })
    ).stdout.trim();
    const scratch = join(input.directory, "compiler-scratch");
    await mkdir(scratch);
    const project = await loadMetalProject({
      configurationPath: input.configurationPath,
    });
    const marker = "VGPU_PRIVATE_CONTEXT_NOT_FOR_GENERATED_FILES";
    const environment = {
      ...process.env,
      DEVELOPER_DIR: selected,
      TMPDIR: scratch,
      VGPU_PREPARATION_SECRET: marker,
    };
    const pending = prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
      environment,
    });
    environment.DEVELOPER_DIR = join(input.directory, "changed-explicit-xcode");
    environment.TMPDIR = join(input.directory, "changed-explicit-temp");
    process.env.DEVELOPER_DIR = join(input.directory, "changed-ambient-xcode");
    process.env.TMPDIR = join(input.directory, "changed-ambient-temp");
    const prepared = await pending;
    expect(prepared.record.inputFingerprint).toBe(project.inputFingerprint);
    expect(await readdir(scratch)).toEqual([]);
    for (const bytes of Object.values(prepared.files)) {
      expect(Buffer.from(bytes).includes(Buffer.from(marker))).toBe(false);
      expect(Buffer.from(bytes).includes(Buffer.from(scratch))).toBe(false);
    }
    expect(await readdir(input.directory)).toEqual([
      "compiler-scratch",
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("relative tool, temp and project selections keep their invocation meaning after cwd changes without mutating caller environment", async () => {
  const input = await projectFixture();
  const invocation = process.cwd();
  try {
    const selected = (
      await promisify(execFile)("/usr/bin/xcode-select", ["--print-path"], {
        timeout: 10_000,
      })
    ).stdout.trim();
    const scratch = join(input.directory, "relative-temp");
    await mkdir(scratch);
    const environment = {
      ...process.env,
      DEVELOPER_DIR: relative(invocation, selected),
      TMPDIR: relative(invocation, scratch),
    };
    const supplied: NodeJS.ProcessEnv = { ...environment };
    const pending = prepareMetalProject({
      configurationPath: relative(invocation, input.configurationPath),
      workerPath: relative(invocation, workerPath),
      environment,
    });
    process.chdir(input.directory);
    const prepared = await pending;
    expect(prepared.project.filePath).toBe(input.configurationPath);
    expect(prepared.record.ownerConfiguration).toBe("../../vgpu.native.json");
    // Compare ownership without dumping a real process environment on failure.
    expect(Object.keys(environment).length).toBe(Object.keys(supplied).length);
    expect(
      Object.entries(environment).every(
        ([key, value]) => value === supplied[key]
      )
    ).toBe(true);
    expect(await readdir(scratch)).toEqual([]);
    expect(await readdir(input.directory)).toEqual([
      "relative-temp",
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    process.chdir(invocation);
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("edits after compilation begins cannot splice newer source or configuration into a preparation or replace existing output", async () => {
  const input = await projectFixture();
  const originalOpen = filesystem.open;
  let opening: MockInstance<typeof filesystem.open> | undefined;
  try {
    const baseline = await loadMetalProject({
      configurationPath: input.configurationPath,
    });
    await mkdir(input.outputPath, { recursive: true });
    const marker = join(input.outputPath, "keep.txt");
    await filesystem.writeFile(marker, "Existing application-owned output");
    const entry = join(input.directory, "shaders/count.wgsl");
    const changedShader = (await readFile(entry, "utf8")).replace(
      "100u",
      "700u"
    );
    let changed = false;
    // Opening the actual pinned binary happens only after complete path preflight.
    opening = vi
      .spyOn(filesystem, "open")
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === workerPath && !changed) {
          changed = true;
          writeFileSync(entry, changedShader);
          writeFileSync(
            input.configurationPath,
            JSON.stringify({
              ...projectConfiguration,
              moduleName: "ChangedShaders",
            })
          );
        }
        return handle;
      });
    const options = {
      configurationPath: input.configurationPath,
      workerPath,
      signal: new AbortController().signal,
    };
    const pending = prepareMetalProject(options);
    options.configurationPath = join(input.directory, "missing.json");
    options.workerPath = join(input.directory, "missing-worker");
    options.signal = AbortSignal.abort();
    const prepared = await pending;
    expect(changed).toBe(true);
    expect(prepared.record.moduleName).toBe("AppShaders");
    expect(prepared.record.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(await executeCount(prepared.files)).toEqual([100, 101]);
    expect(
      (await loadMetalProject({ configurationPath: input.configurationPath }))
        .inputFingerprint
    ).not.toBe(prepared.record.inputFingerprint);
    expect(await readdir(input.outputPath)).toEqual(["keep.txt"]);
    expect(await readFile(marker, "utf8")).toBe(
      "Existing application-owned output"
    );
  } finally {
    opening?.mockRestore();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("offline compiler failure cleans scratch and preserves existing output without exposing the complete host environment", async () => {
  const input = await projectFixture();
  try {
    await mkdir(input.outputPath, { recursive: true });
    const marker = join(input.outputPath, "keep.txt");
    await filesystem.writeFile(marker, "Existing application output");
    const scratch = join(input.directory, "failed-compiler-scratch");
    await mkdir(scratch);
    const secret = "VGPU_PRIVATE_ENV_NOT_FOR_DIAGNOSTICS";
    const error = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
      environment: {
        ...process.env,
        DEVELOPER_DIR: join(input.directory, "missing-xcode"),
        TMPDIR: scratch,
        VGPU_PREPARATION_SECRET: secret,
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );
    expect(error).toMatchObject({ name: "MetalCompileError", stage: "metal" });
    expect(inspect(error, { depth: null })).not.toContain(secret);
    expect(await readdir(scratch)).toEqual([]);
    expect(await readdir(input.outputPath)).toEqual(["keep.txt"]);
    expect(await readFile(marker, "utf8")).toBe("Existing application output");
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancellation during the final compiled-library read rejects preparation after owned cleanup", async () => {
  const input = await projectFixture();
  const originalReadFile = filesystem.readFile;
  let reading: MockInstance<typeof filesystem.readFile> | undefined;
  try {
    await mkdir(input.outputPath, { recursive: true });
    const marker = join(input.outputPath, "keep.txt");
    await filesystem.writeFile(marker, "Existing application output");
    const scratch = join(input.directory, "late-cancel-scratch");
    await mkdir(scratch);
    await filesystem.writeFile(
      join(scratch, "keep.txt"),
      "Caller-owned scratch marker"
    );
    const controller = new AbortController();
    const reason = new Error("Cancelled while reading the compiled library");
    let cancelled = false;
    // Keep real Tint, Metal compilation/linking, file bytes, and cleanup. Inject
    // only the external cancellation event at the final asynchronous file read.
    reading = vi
      .spyOn(filesystem, "readFile")
      .mockImplementation(async (...args) => {
        const bytes = await originalReadFile(...args);
        if (
          typeof args[0] === "string" &&
          args[0].startsWith(`${scratch}/`) &&
          args[0].endsWith("/Shaders.metallib")
        ) {
          expect(
            Buffer.isBuffer(bytes) && bytes.subarray(0, 4).toString()
          ).toBe("MTLB");
          cancelled = true;
          controller.abort(reason);
        }
        return bytes;
      });
    const outcome = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
      signal: controller.signal,
      environment: { ...process.env, TMPDIR: scratch },
    }).then(
      () => ({ kind: "prepared" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    );
    expect(cancelled).toBe(true);
    expect(await readdir(scratch)).toEqual(["keep.txt"]);
    expect(await readFile(join(scratch, "keep.txt"), "utf8")).toBe(
      "Caller-owned scratch marker"
    );
    expect(await readdir(input.outputPath)).toEqual(["keep.txt"]);
    expect(await readFile(marker, "utf8")).toBe("Existing application output");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.error).toBe(reason);
  } finally {
    reading?.mockRestore();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("mutating an owned payload cannot alter the frozen record or another returned file", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const libraryPath = "Sources/AppShaders/Resources/Shaders.metallib";
    const library = prepared.files[libraryPath];
    const oldHash = prepared.record.files.find(
      (file) => file.path === libraryPath
    )!.sha256;
    const recordBytes = Buffer.from(prepared.files[metalOutputRecordPath]);
    const swiftBytes = Buffer.from(
      prepared.files["Sources/AppShaders/Shaders.generated.swift"]
    );
    expect(Object.isFrozen(library)).toBe(false);
    library[0] ^= 0xff;
    expect(createHash("sha256").update(library).digest("hex")).not.toBe(
      oldHash
    );
    expect(
      prepared.record.files.find((file) => file.path === libraryPath)!.sha256
    ).toBe(oldHash);
    expect(Buffer.from(prepared.files[metalOutputRecordPath])).toEqual(
      recordBytes
    );
    expect(
      Buffer.from(prepared.files["Sources/AppShaders/Shaders.generated.swift"])
    ).toEqual(swiftBytes);
    expect(Reflect.set(prepared.files, "extra.txt", new Uint8Array([1]))).toBe(
      false
    );
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("default preparation captures the ambient tool environment before project awaits", async () => {
  const input = await projectFixture();
  const previous = {
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  try {
    const selected = (
      await promisify(execFile)("/usr/bin/xcode-select", ["--print-path"], {
        timeout: 10_000,
      })
    ).stdout.trim();
    const scratch = join(input.directory, "ambient-scratch");
    await mkdir(scratch);
    process.env.DEVELOPER_DIR = selected;
    process.env.TMPDIR = scratch;
    const pending = prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    process.env.DEVELOPER_DIR = join(input.directory, "changed-ambient-xcode");
    process.env.TMPDIR = join(input.directory, "changed-ambient-temp");
    const prepared = await pending;
    expect(prepared.record.moduleName).toBe("AppShaders");
    expect(await readdir(scratch)).toEqual([]);
    expect(await readdir(input.directory)).toEqual([
      "ambient-scratch",
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(input.directory, { recursive: true, force: true });
  }
});

async function executeCount(
  files: Readonly<Record<string, Uint8Array>>
): Promise<number[]> {
  const output = await runConsumer(
    { AppShaders: { files } },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
precondition(Count.workgroupSize.width == 2)
let outputBuffer = device.makeBuffer(length: 8, options: .storageModeShared)!
let bindings = Count.Bindings(output: ShaderBufferRange(buffer: outputBuffer, offset: 0, length: 8))
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${swift[3]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
let values = (0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian }
print(String(data: try JSONSerialization.data(withJSONObject: values), encoding: .utf8)!)
`
  );
  return JSON.parse(output);
}
