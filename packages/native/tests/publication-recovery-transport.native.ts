import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { readPublicationResponseLines } from "../src/tooling/publication-response-lines.ts";

test("a named FIFO journal is rejected without unblocking its waiting writer", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-recovery-fifo-"))
  );
  let writer: ReturnType<typeof spawn> | undefined;
  let writerClosed: Promise<unknown> | undefined;
  let helper: ReturnType<typeof spawn> | undefined;
  let helperClosed: Promise<unknown> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let replies: ReturnType<typeof readPublicationResponseLines> | undefined;
  let writerReplies:
    | ReturnType<typeof readPublicationResponseLines>
    | undefined;
  try {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("DYLD_") && !name.startsWith("LD_")
      )
    );
    const run = promisify(execFile);
    const compile = async (
      source: string,
      executable: string,
      flags: readonly string[] = []
    ) => {
      await run(
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
          ...flags,
          source,
          "-o",
          executable,
        ],
        {
          env: environment,
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        }
      );
    };
    const executable = join(root, "publication-staging");
    const writerExecutable = join(root, "fifo-writer");
    const observer = join(root, "fifo-open-observer.dylib");
    const fixture = fileURLToPath(
      new URL("./fixtures/publication-recovery-fifo.c", import.meta.url)
    );
    await compile(
      fileURLToPath(
        new URL("../src/tooling/publication-staging.c", import.meta.url)
      ),
      executable
    );
    await compile(fixture, writerExecutable);
    await compile(fixture, observer, [
      "-dynamiclib",
      "-DPUBLICATION_RECOVERY_FIFO_OBSERVER",
    ]);
    const parent = join(root, "Generated");
    await mkdir(parent);
    const journal = join(parent, ".vgpu-native-publication.json");
    const sentinel = join(parent, "sentinel");
    await writeFile(sentinel, "preserve unrelated bytes");
    await run("/usr/bin/mkfifo", [journal], {
      env: environment,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const before = await lstat(journal, { bigint: true });
    const opened = join(root, "writer-opened");
    const exited = (child: ReturnType<typeof spawn>) =>
      new Promise((resolve) => {
        let spawnError: Error | undefined;
        child.once("error", (error) => {
          spawnError = error;
        });
        child.once("close", (code, signal) =>
          resolve({ code, signal, spawnError })
        );
      });
    writer = spawn(writerExecutable, [journal, opened], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writerClosed = exited(writer);
    writer.stderr!.resume();
    deadline = setTimeout(() => {
      timedOut = true;
      writer?.kill("SIGKILL");
      helper?.kill("SIGKILL");
    }, 10_000);
    writerReplies = readPublicationResponseLines(writer.stdout!);
    expect(await writerReplies.next()).toEqual({
      done: false,
      value: "opening",
    });
    helper = spawn(
      executable,
      [
        "vgpu-publication-staging/v1",
        parent,
        "AppShaders",
        "AppShaders",
        "0123456789abcdef0123456789abcdef",
      ],
      {
        env: {
          ...environment,
          DYLD_INSERT_LIBRARIES: observer,
          VGPU_FIFO_WRITER_OPENED: opened,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    helperClosed = exited(helper);
    helper.stdin!.on("error", () => {});
    helper.stderr!.resume();
    replies = readPublicationResponseLines(helper.stdout!);
    const reply = await replies.next();
    expect(reply.done).toBe(false);
    expect(JSON.parse(reply.value!)).toMatchObject({
      schemaVersion: 1,
      kind: "error",
      code: "conflict",
    });
    expect(await helperClosed).toEqual({
      code: 1,
      signal: null,
      spawnError: undefined,
    });
    expect(timedOut).toBe(false);
    await expect(lstat(opened)).rejects.toMatchObject({ code: "ENOENT" });
    expect(writer.exitCode).toBe(null);
    expect(writer.signalCode).toBe(null);
    const after = await lstat(journal, { bigint: true });
    expect({ device: after.dev, inode: after.ino, mode: after.mode }).toEqual({
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
    });
    expect(after.isFIFO()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("preserve unrelated bytes");
    expect((await readdir(parent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      "sentinel",
    ]);
  } finally {
    clearTimeout(deadline);
    helper?.kill("SIGKILL");
    writer?.kill("SIGKILL");
    if (helperClosed) await helperClosed;
    if (writerClosed) await writerClosed;
    await replies?.return();
    await writerReplies?.return();
    await rm(root, { recursive: true, force: true });
  }
});
