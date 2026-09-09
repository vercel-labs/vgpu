import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  cancelOnRecoveryComplete: undefined as AbortController | undefined,
}));
// Observe an actual completed helper report; never substitute or alter response bytes.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (
        boundary.cancelOnRecoveryComplete &&
        args[0].endsWith("/publication-staging")
      ) {
        let response = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          response += chunk.toString("utf8");
          if (response.includes('"kind":"recovery-complete"'))
            boundary.cancelOnRecoveryComplete?.abort(
              new Error("cancelled after recovery report")
            );
        });
      }
      return child;
    }) as typeof actual.spawn,
  };
});
import { loadMetalProject } from "../src/tooling/project.ts";
import {
  createMetalOutputRecord,
  parseMetalOutputRecord,
} from "../src/tooling/output-record.ts";
import { readPublicationResponseLines } from "../src/tooling/publication-response-lines.ts";
import { withPreparedMetalPublicationStage } from "../src/tooling/publication-staging.ts";
import { projectFixture } from "./project-operation-fixture.ts";

test.each([
  { phase: "staging", cancelled: false, journalForm: "original" },
  { phase: "staging", cancelled: true, journalForm: "original" },
  { phase: "prepared", cancelled: false, journalForm: "original" },
  { phase: "intent", cancelled: false, journalForm: "original" },
  { phase: "staging", cancelled: false, journalForm: "maximum" },
  { phase: "staging", cancelled: false, journalForm: "unknown-field" },
  { phase: "staging", cancelled: false, journalForm: "wrong-parent" },
  { phase: "prepared", cancelled: false, journalForm: "wrong-record-digest" },
])(
  "a later sibling build preserves interrupted $phase evidence (cancelled: $cancelled, journal: $journalForm)",
  async ({ phase, cancelled, journalForm }) => {
    const input = await projectFixture();
    let helper: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const project = await loadMetalProject({
        configurationPath: input.configurationPath,
      });
      const parent = dirname(project.outputPath);
      const executable = join(input.directory, "publication-staging");
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
          fileURLToPath(
            new URL("../src/tooling/publication-staging.c", import.meta.url)
          ),
          "-o",
          executable,
        ],
        { timeout: 30_000, killSignal: "SIGKILL" }
      );
      const transactionId = "0123456789abcdef0123456789abcdef";
      let wrapper: string | undefined;
      let intentLength: number | undefined;
      if (phase === "intent") {
        await mkdir(parent);
        const parentIdentity = await lstat(parent, { bigint: true });
        intentLength = Buffer.byteLength(
          JSON.stringify({
            schemaVersion: 1,
            kind: "vgpu-native-publication",
            phase: "intent",
            transactionId,
            parent: {
              device: parentIdentity.dev.toString(),
              inode: parentIdentity.ino.toString(),
            },
            destinationName: "EarlierShaders",
            moduleName: "EarlierShaders",
          }) + "\n"
        );
        wrapper = join(input.directory, "limit-helper-writes");
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
            `-DPUBLICATION_TEST_FILE_LIMIT=${intentLength}`,
            fileURLToPath(
              new URL(
                "./fixtures/publication-file-size-limit.c",
                import.meta.url
              )
            ),
            "-o",
            wrapper,
          ],
          { timeout: 30_000, killSignal: "SIGKILL" }
        );
      }
      helper = spawn(
        wrapper ?? executable,
        [
          ...(wrapper ? [executable] : []),
          "vgpu-publication-staging/v1",
          parent,
          "EarlierShaders",
          "EarlierShaders",
          transactionId,
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      closed = new Promise((resolve) =>
        helper!.once("close", (code, signal) => resolve({ code, signal }))
      );
      deadline = setTimeout(() => helper?.kill("SIGKILL"), 10_000);
      helper.stdin!.on("error", () => {});
      helper.stderr!.resume();
      const lines = readPublicationResponseLines(helper.stdout!);
      const ready = await lines.next();
      expect(ready.done).toBe(false);
      if (phase === "intent")
        expect(JSON.parse(ready.value!)).toMatchObject({
          kind: "error",
          code: "helper-failed",
          retainedUpdate: true,
        });
      else
        expect(JSON.parse(ready.value!)).toEqual({
          schemaVersion: 1,
          kind: "ready",
        });
      if (phase === "prepared") {
        const earlierFiles = {
          "Package.swift": Buffer.from("manifest payload"),
          "Sources/EarlierShaders/Shaders.generated.swift":
            Buffer.from("Swift payload"),
          "Sources/EarlierShaders/Resources/Shaders.metallib":
            Buffer.from("library payload"),
        };
        const earlierRecord = createMetalOutputRecord({
          moduleName: "EarlierShaders",
          ownerConfiguration: relative(
            join(parent, "EarlierShaders"),
            project.filePath
          ),
          inputFingerprint: project.inputFingerprint,
          files: earlierFiles,
        });
        const send = (bytes: Uint8Array) =>
          new Promise<void>((resolve, reject) =>
            helper!.stdin!.write(bytes, (error) =>
              error ? reject(error) : resolve()
            )
          );
        for (const [index, bytes] of [
          ...Object.values(earlierFiles),
          earlierRecord,
        ].entries()) {
          await send(
            Buffer.from(
              `file ${index} ${bytes.byteLength} ${createHash("sha256")
                .update(bytes)
                .digest("hex")}\n`
            )
          );
          await send(bytes);
        }
        await send(Buffer.from("prepare\n"));
        const receipt = await lines.next();
        expect(receipt.done).toBe(false);
        expect(JSON.parse(receipt.value!)).toMatchObject({
          kind: "prepared",
          transactionId,
        });
      }
      if (phase !== "intent") helper.kill("SIGKILL");
      expect(await closed).toEqual(
        phase === "intent"
          ? { code: 1, signal: null }
          : { code: null, signal: "SIGKILL" }
      );
      await lines.return?.();
      clearTimeout(deadline);
      const journalPath = join(parent, ".vgpu-native-publication.json");
      const stagePath = join(parent, ".vgpu-native-stage");
      const updatePath = join(parent, ".vgpu-native-publication.update.json");
      if (phase === "intent")
        expect((await lstat(updatePath)).size).toBe(intentLength);
      if (cancelled)
        await writeFile(updatePath, "partial update evidence", {
          flag: "wx",
          mode: 0o600,
        });
      expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
        phase,
        transactionId,
        destinationName: "EarlierShaders",
      });
      const originalJournal = await readFile(journalPath);
      if (journalForm === "maximum")
        await writeFile(
          journalPath,
          Buffer.concat([
            originalJournal,
            Buffer.alloc(64 * 1024 - originalJournal.byteLength, 0x20),
          ])
        );
      else if (journalForm === "unknown-field")
        await writeFile(
          journalPath,
          JSON.stringify({
            ...JSON.parse(originalJournal.toString("utf8")),
            unexpected: true,
          })
        );
      else if (journalForm === "wrong-parent") {
        const changed = JSON.parse(originalJournal.toString("utf8"));
        changed.parent.inode = (BigInt(changed.parent.inode) + 1n).toString();
        await writeFile(journalPath, JSON.stringify(changed));
      } else if (journalForm === "wrong-record-digest") {
        const changed = JSON.parse(originalJournal.toString("utf8"));
        changed.recordSHA256 =
          (changed.recordSHA256[0] === "0" ? "1" : "0") +
          changed.recordSHA256.slice(1);
        await writeFile(journalPath, JSON.stringify(changed));
      }
      const before = await treeEvidence(parent);

      // No compilation claim: a valid prepared envelope suffices to exercise the startup boundary.
      const moduleName = project.configuration.moduleName;
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
      let called = false;
      // A second report must also succeed: the first report cannot leave the parent lock held.
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        if (cancelled) boundary.cancelOnRecoveryComplete = controller;
        const error = await withPreparedMetalPublicationStage(
          { prepared, signal: controller.signal },
          async () => {
            called = true;
          }
        ).catch((cause: unknown) => cause);
        const recoveryPaths = [
          stagePath,
          journalPath,
          ...(cancelled || phase === "intent" ? [updatePath] : []),
        ];
        const interrupted = {
          code: "interrupted-transaction",
          transaction: {
            transactionId,
            phase,
            destinationName: "EarlierShaders",
            outputPath: join(parent, "EarlierShaders"),
          },
          recoveryPaths,
        };
        if (cancelled) {
          expect(controller.signal.aborted).toBe(true);
          expect(error).toMatchObject({
            code: "cancelled",
            recoveryPaths,
            cause: { errors: [controller.signal.reason, interrupted] },
          });
        } else if (
          ["unknown-field", "wrong-parent", "wrong-record-digest"].includes(
            journalForm
          )
        ) {
          expect(error).toMatchObject({ code: "conflict", recoveryPaths });
          expect(error).not.toHaveProperty("transaction");
        } else expect(error).toMatchObject(interrupted);
        expect(called).toBe(false);
        expect(await treeEvidence(parent)).toEqual(before);
        await expect(lstat(project.outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      boundary.cancelOnRecoveryComplete = undefined;
      clearTimeout(deadline);
      helper?.kill("SIGKILL");
      if (closed) await closed;
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);

async function treeEvidence(root: string): Promise<unknown> {
  const stat = await lstat(root, { bigint: true });
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    content: stat.isDirectory()
      ? await Promise.all(
          (await readdir(root))
            .sort()
            .map(async (name) => [name, await treeEvidence(join(root, name))])
        )
      : await readFile(root),
  };
}
