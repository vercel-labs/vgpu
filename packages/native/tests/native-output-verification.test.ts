import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { promisify } from "node:util";
import * as filesystem from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import {
  createMetalOutputRecord,
  metalOutputRecordPath,
} from "../src/tooling/output-record.ts";
import { verifyMetalOutput } from "../src/tooling/output-verification.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu native verify "))
  );
  const configurationPath = join(directory, "vgpu.native.json");
  const outputPath = join(directory, "AppShaders");
  await writeFile(configurationPath, "{}");
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    programs: [{ name: "Triangle", functions: { vertex: "vertex_main" } }],
    // This fixture tests artifact integrity, not native Metal compilation.
    library: new Uint8Array([1, 2, 3]),
  });
  const files: Record<string, Uint8Array> = {
    ...generated.files,
    [metalOutputRecordPath]: createMetalOutputRecord({
      moduleName: "AppShaders",
      ownerConfiguration: "../vgpu.native.json",
      inputFingerprint: "a".repeat(64),
      files: generated.files,
    }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(outputPath, path)), { recursive: true });
    await writeFile(join(outputPath, path), bytes);
  }
  return { directory, configurationPath, outputPath, files };
}

test("an unchanged generated directory verifies without rewriting any bytes", async () => {
  const input = await fixture();
  try {
    const record = await verifyMetalOutput(input);
    expect(record.moduleName).toBe("AppShaders");
    expect(record.inputFingerprint).toBe("a".repeat(64));
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.files).toHaveLength(3);
    for (const [path, bytes] of Object.entries(input.files)) {
      expect(await readFile(join(input.outputPath, path))).toEqual(
        Buffer.from(bytes)
      );
    }
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("same-size modified payloads fail integrity checks and remain untouched", async () => {
  const input = await fixture();
  try {
    const path = join(
      input.outputPath,
      "Sources/AppShaders/Resources/Shaders.metallib"
    );
    const modified = Buffer.from([3, 2, 1]);
    await writeFile(path, modified);
    await expect(verifyMetalOutput(input)).rejects.toMatchObject({
      code: "invalid-output",
    });
    expect(await readFile(path)).toEqual(modified);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("ownership follows the current configuration file, not its contents or the stale input fingerprint", async () => {
  const input = await fixture();
  try {
    await writeFile(input.configurationPath, '{"moduleName":"RenamedModule"}');
    expect((await verifyMetalOutput(input)).inputFingerprint).toBe(
      "a".repeat(64)
    );
    const foreign = join(input.directory, "foreign.json");
    await writeFile(foreign, await readFile(input.configurationPath));
    await expect(
      verifyMetalOutput({ ...input, configurationPath: foreign })
    ).rejects.toMatchObject({ code: "output-owner-mismatch" });
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("unexpected files and empty directories are reported without being removed", async () => {
  for (const addition of ["notes.txt", ".build", "Sources/AppShaders/Unused"]) {
    const input = await fixture();
    try {
      const path = join(input.outputPath, addition);
      if (addition.endsWith(".txt")) await writeFile(path, "keep me");
      else await mkdir(path);
      await expect(verifyMetalOutput(input)).rejects.toMatchObject({
        code: "invalid-output",
      });
      if (addition.endsWith(".txt"))
        expect(await readFile(path, "utf8")).toBe("keep me");
      else expect(await realpath(path)).toBe(path);
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  }
});

test("hard-linked records and payloads are not accepted as tool-owned files", async () => {
  for (const path of [metalOutputRecordPath, "Package.swift"]) {
    const input = await fixture();
    try {
      const original = join(input.outputPath, path);
      const linked = join(input.directory, "keep-linked-file");
      await link(original, linked);
      await expect(verifyMetalOutput(input)).rejects.toMatchObject({
        code: "invalid-output",
      });
      expect(await readFile(linked)).toEqual(Buffer.from(input.files[path]!));
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  }
});

test("symbolic links in the output path, directories, record, or payload fail inspection", async () => {
  for (const path of [".", "Sources", metalOutputRecordPath, "Package.swift"]) {
    const input = await fixture();
    try {
      const original = join(input.outputPath, path);
      const saved = join(input.directory, "saved");
      await rename(original, saved);
      await symlink(saved, original);
      await expect(verifyMetalOutput(input)).rejects.toMatchObject({
        code: "invalid-output",
      });
      expect(await realpath(original)).toBe(saved);
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  }
});

test("a cancelled inspection rejects without changing the output", async () => {
  const input = await fixture();
  try {
    await expect(
      verifyMetalOutput({ ...input, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "cancelled" });
    expect((await verifyMetalOutput(input)).files).toHaveLength(3);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a payload that grows after its size observation is rejected even when the new bytes match the record", async () => {
  const input = await fixture();
  const path = join(
    input.outputPath,
    "Sources/AppShaders/Resources/Shaders.metallib"
  );
  try {
    const grown = Buffer.from([1, 2, 3, 4]);
    const record = JSON.parse(
      Buffer.from(input.files[metalOutputRecordPath]!).toString("utf8")
    );
    record.files.find((file: { path: string }) =>
      file.path.endsWith("Shaders.metallib")
    ).sha256 = createHash("sha256").update(grown).digest("hex");
    await writeFile(
      join(input.outputPath, metalOutputRecordPath),
      JSON.stringify(record)
    );
    const open = filesystem.open;
    let changed = false;
    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
          const observed = await stat(...statArgs);
          await writeFile(path, grown);
          changed = true;
          return observed;
        });
      }
      return handle;
    });
    await expect(verifyMetalOutput(input)).rejects.toMatchObject({
      code: "invalid-output",
    });
    expect(changed).toBe(true);
    expect(await readFile(path)).toEqual(grown);
  } finally {
    vi.restoreAllMocks();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a record replaced after it was read cannot produce a successful stale observation", async () => {
  const input = await fixture();
  try {
    const recordPath = join(input.outputPath, metalOutputRecordPath);
    const open = filesystem.open;
    let changed = false;
    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      if (args[0] === join(input.outputPath, "Package.swift")) {
        await writeFile(
          recordPath,
          Buffer.from(input.files[metalOutputRecordPath]!)
            .toString("utf8")
            .replace("a".repeat(64), "b".repeat(64))
        );
        changed = true;
      }
      return await open(...args);
    });
    await expect(verifyMetalOutput(input)).rejects.toMatchObject({
      code: "invalid-output",
    });
    expect(changed).toBe(true);
    expect(await readFile(recordPath, "utf8")).toContain("b".repeat(64));
  } finally {
    vi.restoreAllMocks();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a file added after directory enumeration is reported and preserved", async () => {
  const input = await fixture();
  try {
    const extra = join(input.outputPath, "notes.txt");
    const open = filesystem.open;
    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      if (args[0] === join(input.outputPath, "Package.swift"))
        await writeFile(extra, "keep me");
      return await open(...args);
    });
    await expect(verifyMetalOutput(input)).rejects.toMatchObject({
      code: "invalid-output",
    });
    expect(await readFile(extra, "utf8")).toBe("keep me");
  } finally {
    vi.restoreAllMocks();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("verification survives relocation, an atomic config save, and caller option mutation", async () => {
  const input = await fixture();
  try {
    const saved = join(input.directory, "new-config.json");
    await writeFile(saved, '{"moduleName":"RenamedModule"}');
    await rename(saved, input.configurationPath);
    const relocated = join(input.directory, "relocated");
    await mkdir(relocated);
    await rename(input.outputPath, join(relocated, "AppShaders"));
    await rename(input.configurationPath, join(relocated, "vgpu.native.json"));
    const options = {
      outputPath: join(relocated, "AppShaders"),
      configurationPath: join(relocated, "vgpu.native.json"),
    };
    const pending = verifyMetalOutput(options);
    options.outputPath = join(input.directory, "does-not-exist");
    options.configurationPath = options.outputPath;
    expect((await pending).moduleName).toBe("AppShaders");
    const configAlias = join(relocated, "config-alias.json");
    await symlink(join(relocated, "vgpu.native.json"), configAlias);
    expect(
      (
        await verifyMetalOutput({
          outputPath: join(relocated, "AppShaders"),
          configurationPath: configAlias,
        })
      ).files
    ).toHaveLength(3);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("malformed and oversized records fail before payload files are opened", async () => {
  const input = await fixture();
  try {
    const recordPath = join(input.outputPath, metalOutputRecordPath);
    const valid = Buffer.from(input.files[metalOutputRecordPath]!).toString(
      "utf8"
    );
    await writeFile(recordPath, valid.padEnd(64 * 1024, " "));
    expect((await verifyMetalOutput(input)).files).toHaveLength(3);
    for (const bytes of [
      Buffer.from("{broken"),
      Buffer.from(valid.padEnd(64 * 1024 + 1, " ")),
      Buffer.from([0xff]),
    ]) {
      await writeFile(recordPath, bytes);
      const open = vi.spyOn(filesystem, "open");
      await expect(verifyMetalOutput(input)).rejects.toMatchObject({
        code: "invalid-output",
      });
      expect(open.mock.calls.map((args) => args[0])).toEqual([recordPath]);
      open.mockRestore();
    }
  } finally {
    vi.restoreAllMocks();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancellation during an actual payload read closes the handle before returning", async () => {
  const input = await fixture();
  try {
    const controller = new AbortController();
    const open = filesystem.open;
    let closed = false;
    let cancelledDuringRead = false;
    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === join(input.outputPath, "Package.swift")) {
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          const result = await read(...readArgs);
          controller.abort();
          cancelledDuringRead = true;
          return result;
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed = true;
        });
      }
      return handle;
    });
    await expect(
      verifyMetalOutput({ ...input, signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelledDuringRead).toBe(true);
    expect(closed).toBe(true);
    vi.restoreAllMocks();
    expect((await verifyMetalOutput(input)).files).toHaveLength(3);
  } finally {
    vi.restoreAllMocks();
    await rm(input.directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "FIFO records fail promptly without waiting for a writer",
  async () => {
    const input = await fixture();
    let rescue: ReturnType<typeof setTimeout> | undefined;
    try {
      const path = join(input.outputPath, metalOutputRecordPath);
      await rm(path);
      await promisify(execFile)("mkfifo", [path], { timeout: 1000 });
      let neededWriter = false;
      rescue = setTimeout(() => {
        neededWriter = true;
        const descriptor = openSync(
          path,
          constants.O_RDWR | constants.O_NONBLOCK
        );
        closeSync(descriptor);
      }, 1000);
      await expect(verifyMetalOutput(input)).rejects.toMatchObject({
        code: "invalid-output",
        message: expect.stringContaining("regular files"),
      });
      expect(neededWriter).toBe(false);
    } finally {
      clearTimeout(rescue);
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);
