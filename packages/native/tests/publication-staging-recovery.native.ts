import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  wrapper: undefined as string | undefined,
  cancelOnRetainedUpdate: undefined as AbortController | undefined,
}));
// Apply a kernel write limit to the actual helper process; preserve its protocol and output.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (boundary.wrapper && args[0].endsWith("/publication-staging")) {
        const child = actual.spawn(
          boundary.wrapper,
          [args[0], ...args[1]],
          args[2]
        );
        let response = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          response += chunk.toString("utf8");
          if (response.includes('"retainedUpdate":true'))
            boundary.cancelOnRetainedUpdate?.abort(
              new Error("cancelled after retained update")
            );
        });
        return child;
      }
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});
import { loadMetalProject } from "../src/tooling/project.ts";
import {
  createMetalOutputRecord,
  parseMetalOutputRecord,
} from "../src/tooling/output-record.ts";
import { withPreparedMetalPublicationStage } from "../src/tooling/publication-staging.ts";
import { projectFixture } from "./project-operation-fixture.ts";

test.each([false, true])(
  "a failed journal update preserves recovery locations and the original failure (cancelled: %s)",
  async (cancelled) => {
    const input = await projectFixture();
    try {
      const project = await loadMetalProject({
        configurationPath: input.configurationPath,
      });
      const moduleName = project.configuration.moduleName;
      // Isolate the fixed artifact transport; these small payloads do not claim compiler/GPU coverage.
      const files = {
        "Package.swift": Buffer.from("manifest payload"),
        [`Sources/${moduleName}/Shaders.generated.swift`]:
          Buffer.from("Swift payload"),
        [`Sources/${moduleName}/Resources/Shaders.metallib`]:
          Buffer.from("library payload"),
      };
      const recordBytes = createMetalOutputRecord({
        moduleName,
        ownerConfiguration: relative(project.outputPath, project.filePath),
        inputFingerprint: project.inputFingerprint,
        files,
      });
      const prepared = {
        project,
        record: parseMetalOutputRecord(recordBytes),
        files: { ...files, ".vgpu-native-output.json": recordBytes },
      };
      const preparedJournalLength = await withPreparedMetalPublicationStage(
        { prepared },
        async (receipt) => (await readFile(receipt.journalPath)).byteLength
      );
      const limit = Math.floor(
        (recordBytes.byteLength + preparedJournalLength) / 2
      );
      expect(limit).toBeGreaterThan(recordBytes.byteLength);
      expect(limit).toBeLessThan(preparedJournalLength);
      const wrapper = join(input.directory, "limit-helper-writes");
      await promisify(execFile)(
        "/usr/bin/xcrun",
        [
          "--sdk",
          "macosx",
          "clang",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-mmacosx-version-min=14.0",
          `-DPUBLICATION_TEST_FILE_LIMIT=${limit}`,
          fileURLToPath(
            new URL("./fixtures/publication-file-size-limit.c", import.meta.url)
          ),
          "-o",
          wrapper,
        ],
        { timeout: 30_000, killSignal: "SIGKILL" }
      );
      boundary.wrapper = wrapper;
      const controller = new AbortController();
      if (cancelled) boundary.cancelOnRetainedUpdate = controller;
      const error = await withPreparedMetalPublicationStage(
        { prepared, signal: controller.signal },
        async () => {
          throw new Error(
            "unexpected prepared callback after failed journal write"
          );
        }
      ).catch((cause: unknown) => cause);
      const parent = dirname(input.outputPath);
      const stage = join(parent, ".vgpu-native-stage");
      const journal = join(parent, ".vgpu-native-publication.json");
      const update = join(parent, ".vgpu-native-publication.update.json");
      expect((await lstat(update)).size).toBe(limit);
      expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({
        phase: "staging",
      });
      expect(error).toMatchObject({
        code: cancelled ? "cancelled" : "helper-failed",
        recoveryPaths: [stage, journal, update],
      });
      const helperFailure = {
        code: "helper-failed",
        message: expect.stringContaining(`errno ${constants.errno.EFBIG}`),
      };
      if (cancelled) {
        expect(controller.signal.aborted).toBe(true);
        expect(error).toMatchObject({
          cause: { errors: [controller.signal.reason, helperFailure] },
        });
      } else expect(error).toMatchObject(helperFailure);
      await expect(lstat(input.outputPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      boundary.wrapper = undefined;
      boundary.cancelOnRetainedUpdate = undefined;
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);
