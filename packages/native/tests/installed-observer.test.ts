import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  copyInstalledObserver,
  type InstalledObserverTemplate,
} from "./installed-observer.ts";

async function withTemplate(
  run: (directory: string, template: InstalledObserverTemplate) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-installed-observer-"));
  try {
    const path = join(directory, "template.dylib");
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    await writeFile(path, bytes, { mode: 0o755 });
    await run(directory, {
      path,
      bytes,
      metadata: await lstat(path, { bigint: true }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("each installed fault case gets independent observer bytes with the original mode", async () => {
  await withTemplate(async (directory, template) => {
    const first = join(directory, "first.dylib");
    const second = join(directory, "second.dylib");
    await copyInstalledObserver(template, first);
    await copyInstalledObserver(template, second);
    const identities = [template.metadata];
    for (const path of [first, second]) {
      expect(await readFile(path)).toEqual(template.bytes);
      const metadata = await lstat(path, { bigint: true });
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1n);
      expect(metadata.mode).toBe(template.metadata.mode);
      expect(
        identities.some(
          (item) => item.dev === metadata.dev && item.ino === metadata.ino
        )
      ).toBe(false);
      identities.push(metadata);
    }
    await writeFile(first, Buffer.from([9, 9, 9, 9, 9]));
    expect(await readFile(template.path)).toEqual(template.bytes);
    expect(await readFile(second)).toEqual(template.bytes);
  });
});

test("a same-size edit of the compiled template cannot silently enter a later fault case", async () => {
  await withTemplate(async (directory, template) => {
    const destination = join(directory, "case.dylib");
    const changed = Buffer.from(template.bytes);
    changed[0] = changed[0]! ^ 1;
    await writeFile(template.path, changed);
    await expect(copyInstalledObserver(template, destination)).rejects.toThrow(
      "Observer template changed"
    );
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(template.path)).toEqual(changed);
  });
});

test("replacement of the template with identical bytes is rejected before copying", async () => {
  await withTemplate(async (directory, template) => {
    const destination = join(directory, "case.dylib");
    await rename(template.path, join(directory, "original.dylib"));
    await writeFile(template.path, template.bytes, {
      mode: Number(template.metadata.mode & 0o777n),
    });
    await expect(copyInstalledObserver(template, destination)).rejects.toThrow(
      "Observer template changed"
    );
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test.each(["mode", "hardlink", "symlink"])(
  "a template %s change is rejected without creating a copy",
  async (change) => {
    await withTemplate(async (directory, template) => {
      const destination = join(directory, "case.dylib");
      try {
        if (change === "mode") {
          await chmod(template.path, 0o444);
          expect((await lstat(template.path, { bigint: true })).mode).not.toBe(
            template.metadata.mode
          );
        } else if (change === "hardlink")
          await link(template.path, join(directory, "alias.dylib"));
        else {
          const original = join(directory, "original.dylib");
          await rename(template.path, original);
          await symlink(original, template.path);
        }
        await expect(
          copyInstalledObserver(template, destination)
        ).rejects.toThrow("Observer template changed");
        await expect(lstat(destination)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        // Windows only exposes the writable permission bit; restore it for cleanup.
        if (change === "mode") await chmod(template.path, 0o600);
      }
    });
  }
);

test("an occupied case path is never overwritten or deleted", async () => {
  await withTemplate(async (directory, template) => {
    const destination = join(directory, "case.dylib");
    const existing = Buffer.from("preexisting case evidence");
    await writeFile(destination, existing);
    const before = await lstat(destination, { bigint: true });
    await expect(
      copyInstalledObserver(template, destination)
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination)).toEqual(existing);
    expect((await lstat(destination, { bigint: true })).ino).toBe(before.ino);
    expect(await readFile(template.path)).toEqual(template.bytes);
  });
});
