import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import * as publication from "../src/tooling/publication-staging.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("a real prepared generation publishes exclusively to an absent destination and survives transaction cleanup", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const receipt = await publication.publishPreparedMetalOutput({ prepared });
    const output = await lstat(input.outputPath, { bigint: true });
    const parent = await lstat(dirname(input.outputPath), { bigint: true });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: "published",
      outcome: "published",
      transactionId: expect.stringMatching(/^[0-9a-f]{32}$/u),
      destinationName: "AppShaders",
      outputPath: input.outputPath,
      parent: { device: parent.dev.toString(), inode: parent.ino.toString() },
      output: { device: output.dev.toString(), inode: output.ino.toString() },
      recordSHA256: createHash("sha256")
        .update(prepared.files[".vgpu-native-output.json"])
        .digest("hex"),
    });
    expect(output.isDirectory()).toBe(true);
    for (const [name, bytes] of Object.entries(prepared.files)) {
      const path = join(input.outputPath, name);
      const stat = await lstat(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
      expect(stat.size).toBe(bytes.byteLength);
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }
    // The verifier checks the exact four-file tree and freshness without a compiler or writes.
    expect(
      await verifyMetalProject({ configurationPath: input.configurationPath })
    ).toMatchObject({
      outputPath: input.outputPath,
      inputFingerprint: prepared.project.inputFingerprint,
    });
    expect(await readdir(dirname(input.outputPath))).toEqual(["AppShaders"]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});
