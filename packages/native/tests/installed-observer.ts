import assert from "node:assert/strict";
import { constants, type BigIntStats } from "node:fs";
import { copyFile, lstat, readFile } from "node:fs/promises";

export type InstalledObserverTemplate = {
  path: string;
  bytes: Buffer;
  metadata: Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink" | "size">;
};

export async function copyInstalledObserver(
  template: InstalledObserverTemplate,
  destination: string
): Promise<void> {
  const original = await lstat(template.path, { bigint: true });
  assert(
    original.isFile() &&
      original.nlink === 1n &&
      (["dev", "ino", "mode", "nlink", "size"] as const).every(
        (key) => original[key] === template.metadata[key]
      ),
    "Observer template changed"
  );
  assert.deepEqual(
    await readFile(template.path),
    template.bytes,
    "Observer template changed"
  );
  await copyFile(template.path, destination, constants.COPYFILE_EXCL);
  const copied = await lstat(destination, { bigint: true });
  assert(
    copied.isFile() && copied.nlink === 1n,
    "Observer copy must be an ordinary single-link file"
  );
  assert(
    copied.dev !== original.dev || copied.ino !== original.ino,
    "Observer copy must have its own identity"
  );
  assert.equal(
    copied.mode,
    template.metadata.mode,
    "Observer copy mode changed"
  );
  assert.equal(
    copied.size,
    BigInt(template.bytes.length),
    "Observer copy size changed"
  );
  assert.deepEqual(
    await readFile(destination),
    template.bytes,
    "Observer copy bytes changed"
  );
}
