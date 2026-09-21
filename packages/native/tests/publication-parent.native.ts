import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";

test("an explicit publication session creates missing container directories before locking the final parent", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-parent-"))
  );
  try {
    await writeFile(join(root, "preserved.txt"), "retain");
    const parentPath = join(root, "Generated packages/Nested");
    expect(
      await withMetalPublicationSession(
        { parentPath, createParentDirectories: true },
        async (session) => {
          const identity = await stat(parentPath, { bigint: true });
          expect(session.parent).toEqual({
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
          });
          await expect(
            withMetalPublicationSession(
              { parentPath },
              async () => "not locked"
            )
          ).rejects.toMatchObject({ code: "busy" });
          return "locked";
        }
      )
    ).toBe("locked");
    expect(await readdir(parentPath)).toEqual([]);
    expect(await readFile(join(root, "preserved.txt"), "utf8")).toBe("retain");
    expect((await readdir(root)).sort()).toEqual([
      "Generated packages",
      "preserved.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent creation is opt-in and never follows symlinks or replaces ordinary files", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-parent-"))
  );
  try {
    await mkdir(join(root, "Target"));
    await writeFile(join(root, "Target/sentinel"), "retain");
    await symlink(join(root, "Target"), join(root, "Link"));
    await writeFile(join(root, "File"), "retain file");
    await expect(
      withMetalPublicationSession(
        { parentPath: join(root, "Missing/Nested") },
        async () => "unexpected"
      )
    ).rejects.toMatchObject({ code: "unsafe-parent" });
    for (const component of ["Link", "File"]) {
      await expect(
        withMetalPublicationSession(
          {
            parentPath: join(root, component, "Missing/Nested"),
            createParentDirectories: true,
          },
          async () => "unexpected"
        )
      ).rejects.toMatchObject({ code: "unsafe-parent" });
    }
    expect((await readdir(root)).sort()).toEqual(["File", "Link", "Target"]);
    expect(await readdir(join(root, "Target"))).toEqual(["sentinel"]);
    expect(await readFile(join(root, "Target/sentinel"), "utf8")).toBe(
      "retain"
    );
    expect(await readFile(join(root, "File"), "utf8")).toBe("retain file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("created container directories remain after callback failure or cancellation", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-parent-"))
  );
  try {
    for (const phase of ["failure", "cancel"]) {
      const parentPath = join(root, phase, "Nested");
      const controller = new AbortController();
      const failure = new Error("Callback failed after container creation");
      const pending = withMetalPublicationSession(
        {
          parentPath,
          createParentDirectories: true,
          signal: controller.signal,
        },
        async () => {
          if (phase === "failure") throw failure;
          controller.abort();
        }
      );
      if (phase === "failure") await expect(pending).rejects.toBe(failure);
      else await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      expect(await readdir(parentPath)).toEqual([]);
      expect(
        await withMetalPublicationSession(
          { parentPath },
          async () => "released"
        )
      ).toBe("released");
    }
    await expect(
      withMetalPublicationSession(
        {
          parentPath: join(root, "NeverCreated/Nested"),
          createParentDirectories: true,
          signal: AbortSignal.abort(),
        },
        async () => "unexpected"
      )
    ).rejects.toMatchObject({ code: "cancelled" });
    expect((await readdir(root)).sort()).toEqual(["cancel", "failure"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent preparation owns its opt-in and representable path before awaiting the toolchain", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-parent-"))
  );
  try {
    const parentPath = join(root, 'Generated "quoted" 🎨/Nested');
    const options = { parentPath, createParentDirectories: true };
    const pending = withMetalPublicationSession(
      options,
      async () => "captured"
    );
    options.parentPath = join(root, "Wrong/Nested");
    options.createParentDirectories = false;
    expect(await pending).toBe("captured");
    expect(await readdir(parentPath)).toEqual([]);
    expect(await readdir(root)).toEqual(['Generated "quoted" 🎨']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container creation rejects path strings that would be substituted before reaching the helper", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-parent-"))
  );
  try {
    await expect(
      withMetalPublicationSession(
        {
          parentPath: join(root, "Generated\ud800"),
          createParentDirectories: true,
        },
        async () => "unexpected"
      )
    ).rejects.toMatchObject({ code: "unsafe-parent" });
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
