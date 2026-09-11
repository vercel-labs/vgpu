import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";

test("moving an opened ancestor cannot redirect container creation or authorize readiness at its replacement", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-parent-race-"))
  );
  const anchor = join(root, "Anchor");
  const moved = join(root, "Moved");
  const scratch = join(root, "Scratch");
  const paused = join(root, "paused");
  const resume = join(root, "resume");
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    await mkdir(anchor);
    await mkdir(scratch);
    const identity = await stat(anchor, { bigint: true });
    const interposer = join(root, "openat-race.dylib");
    await promisify(execFile)(
      "/usr/bin/xcrun",
      [
        "--sdk",
        "macosx",
        "clang",
        "-dynamiclib",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-mmacosx-version-min=14.0",
        fileURLToPath(
          new URL("./fixtures/publication-openat-race.c", import.meta.url)
        ),
        "-o",
        interposer,
      ],
      { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }
    );
    let entered = false;
    pending = withMetalPublicationSession(
      {
        parentPath: join(anchor, "Generated/Nested"),
        createParentDirectories: true,
        signal: controller.signal,
        environment: {
          ...process.env,
          TMPDIR: scratch,
          DYLD_INSERT_LIBRARIES: interposer,
          VGPU_RACE_ANCHOR_DEVICE: identity.dev.toString(),
          VGPU_RACE_ANCHOR_INODE: identity.ino.toString(),
          VGPU_RACE_PAUSED: paused,
          VGPU_RACE_RESUME: resume,
        },
      },
      async () => {
        entered = true;
        return "must not enter";
      }
    ).catch((error: unknown) => error);

    const deadline = Date.now() + 10_000;
    while (
      !(await access(paused).then(
        () => true,
        () => false
      ))
    ) {
      if (Date.now() >= deadline)
        throw new Error("The real openat observation did not arrive");
      await delay(5);
    }
    await rename(anchor, moved);
    await mkdir(anchor);
    await writeFile(join(anchor, "replacement.txt"), "not the opened parent");
    await writeFile(resume, "continue");
    const result = await pending;
    expect(entered).toBe(false);
    expect(await readdir(anchor)).toEqual(["replacement.txt"]);
    expect(result).toMatchObject({ code: "parent-changed" });
    expect(await readdir(join(moved, "Generated/Nested"))).toEqual([]);
    expect(await readdir(scratch)).toEqual([]);
  } finally {
    if (pending) {
      controller.abort();
      await writeFile(resume, "continue");
      await pending;
    }
    await rm(root, { recursive: true, force: true });
  }
});
