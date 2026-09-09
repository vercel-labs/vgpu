import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import { withPreparedMetalPublicationStage } from "../src/tooling/publication-staging.ts";
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("one real prepared generation is journaled, staged, inspectable under lock, and cleaned without publishing", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });

    const result = await withPreparedMetalPublicationStage(
      { prepared },
      async (receipt) => {
        expect(receipt).toMatchObject({
          schemaVersion: 1,
          kind: "prepared",
          destinationName: "AppShaders",
          moduleName: "AppShaders",
        });
        expect(receipt.transactionId).toMatch(/^[a-f0-9]{32}$/u);
        expect(receipt.files.map(({ role }) => role)).toEqual([
          "package-manifest",
          "swift-source",
          "metal-library",
          "output-record",
        ]);
        expect(receipt.files.map(({ path }) => path)).toEqual([
          "Package.swift",
          "Sources/AppShaders/Shaders.generated.swift",
          "Sources/AppShaders/Resources/Shaders.metallib",
          ".vgpu-native-output.json",
        ]);

        const stageIdentity = await stat(receipt.stagePath, { bigint: true });
        expect(stageIdentity.dev.toString()).toBe(receipt.stage.device);
        expect(stageIdentity.ino.toString()).toBe(receipt.stage.inode);
        const journal = JSON.parse(await readFile(receipt.journalPath, "utf8"));
        expect(journal).toEqual({
          schemaVersion: 1,
          kind: "vgpu-native-publication",
          phase: "prepared",
          transactionId: receipt.transactionId,
          parent: receipt.parent,
          destinationName: receipt.destinationName,
          moduleName: receipt.moduleName,
          stage: receipt.stage,
          recordSHA256: receipt.recordSHA256,
          files: receipt.files,
        });
        expect(Buffer.byteLength(JSON.stringify(journal))).toBeLessThanOrEqual(
          64 * 1024
        );

        const tree = await listTree(receipt.stagePath);
        expect(tree).toEqual([
          ".vgpu-native-output.json",
          "Package.swift",
          "Sources/",
          "Sources/AppShaders/",
          "Sources/AppShaders/Resources/",
          "Sources/AppShaders/Resources/Shaders.metallib",
          "Sources/AppShaders/Shaders.generated.swift",
        ]);
        for (const file of receipt.files) {
          const path = join(receipt.stagePath, file.path);
          const metadata = await lstat(path);
          expect(metadata.isFile()).toBe(true);
          expect(metadata.nlink).toBe(1);
          const bytes = await readFile(path);
          expect(bytes).toEqual(Buffer.from(prepared.files[file.path]));
          expect(bytes.byteLength).toBe(file.length);
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            file.sha256
          );
        }
        expect(
          createHash("sha256")
            .update(prepared.files[".vgpu-native-output.json"])
            .digest("hex")
        ).toBe(receipt.recordSHA256);
        await expect(
          withMetalPublicationSession(
            { parentPath: dirname(input.outputPath) },
            async () => "unexpected"
          )
        ).rejects.toMatchObject({ code: "busy" });
        await expect(lstat(input.outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        return "inspected";
      }
    );

    expect(result).toBe("inspected");
    expect(await readdir(dirname(input.outputPath))).toEqual([]);
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cleanup preserves a staged transaction when a file is replaced with the same bytes under a new identity", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    let retainedStage = "";
    let retainedJournal = "";
    const error = await withPreparedMetalPublicationStage(
      { prepared },
      async (receipt) => {
        retainedStage = receipt.stagePath;
        retainedJournal = receipt.journalPath;
        const target = join(receipt.stagePath, "Package.swift");
        const before = await stat(target, { bigint: true });
        const bytes = await readFile(target);
        const replacement = join(input.directory, "same-byte-replacement");
        await writeFile(replacement, bytes);
        await rename(replacement, target);
        const after = await stat(target, { bigint: true });
        expect(after.ino).not.toBe(before.ino);
      }
    ).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toMatchObject({
      name: "MetalPublicationStagingError",
      code: "cleanup-failed",
    });
    expect(await readFile(join(retainedStage, "Package.swift"))).toEqual(
      Buffer.from(prepared.files["Package.swift"])
    );
    expect(JSON.parse(await readFile(retainedJournal, "utf8"))).toMatchObject({
      phase: "prepared",
      destinationName: "AppShaders",
    });
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a callback failure and changed-stage cleanup failure retain both causes and the recovery paths", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const primary = new Error("caller stopped before publication");
    let stagePath = "";
    let journalPath = "";
    const error = await withPreparedMetalPublicationStage(
      { prepared },
      async (receipt) => {
        stagePath = receipt.stagePath;
        journalPath = receipt.journalPath;
        await writeFile(
          join(stagePath, "unexpected.txt"),
          "preserve this evidence"
        );
        throw primary;
      }
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "MetalPublicationStagingCleanupError",
      code: "cleanup-failed",
      errors: [primary, { code: "cleanup-failed" }],
      recoveryPaths: [stagePath, journalPath],
    });
    expect((error as { errors: unknown[] }).errors[0]).toBe(primary);
    expect(await readFile(join(stagePath, "unexpected.txt"), "utf8")).toBe(
      "preserve this evidence"
    );
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await withMetalPublicationSession(
        { parentPath: dirname(input.outputPath) },
        async () => "released"
      )
    ).toBe("released");
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("pre-existing destination, journal, and journal update entries are rejected without modification", async () => {
  const cases = [
    { name: "AppShaders", directory: true },
    { name: ".vgpu-native-publication.json", directory: false },
    { name: ".vgpu-native-publication.update.json", directory: false },
  ] as const;

  for (const conflict of cases) {
    const input = await projectFixture();
    try {
      const prepared = await prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath,
      });
      const parent = dirname(input.outputPath);
      const target = join(parent, conflict.name);
      const sentinel = conflict.directory ? join(target, "sentinel") : target;
      await mkdir(parent, { recursive: true });
      if (conflict.directory) await mkdir(target);
      await writeFile(sentinel, `preserve ${conflict.name}`);
      const before = await lstat(target, { bigint: true });
      const sentinelBefore = await lstat(sentinel, { bigint: true });
      let callbackCalled = false;

      await expect(
        withPreparedMetalPublicationStage({ prepared }, async () => {
          callbackCalled = true;
        })
      ).rejects.toMatchObject({
        name: "MetalPublicationStagingError",
        code: "conflict",
      });

      expect(callbackCalled).toBe(false);
      const after = await lstat(target, { bigint: true });
      expect({ device: after.dev, inode: after.ino, mode: after.mode }).toEqual(
        {
          device: before.dev,
          inode: before.ino,
          mode: before.mode,
        }
      );
      expect(await readFile(sentinel, "utf8")).toBe(
        `preserve ${conflict.name}`
      );
      const sentinelAfter = await lstat(sentinel, { bigint: true });
      expect({
        device: sentinelAfter.dev,
        inode: sentinelAfter.ino,
        mode: sentinelAfter.mode,
      }).toEqual({
        device: sentinelBefore.dev,
        inode: sentinelBefore.ino,
        mode: sentinelBefore.mode,
      });
      if (conflict.directory)
        expect(await readdir(target)).toEqual(["sentinel"]);
      expect(await readdir(parent)).toEqual([conflict.name]);
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
  }
}, 30_000);

async function listTree(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), {
    withFileTypes: true,
  });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    paths.push(entry.isDirectory() ? `${child}/` : child);
    if (entry.isDirectory()) paths.push(...(await listTree(root, child)));
  }
  return paths;
}
