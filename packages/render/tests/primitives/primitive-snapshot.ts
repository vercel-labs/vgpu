import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { expect } from "vitest";

const WIDTH = 256;
const HEIGHT = 256;
const SNAPSHOT_DIR = "packages/render/tests/primitives/__snapshots__";

export async function expectSnapshot(name: string, pngBytes: Uint8Array): Promise<void> {
  const expectedPath = join(process.cwd(), SNAPSHOT_DIR, name);
  if (process.env.VGPU_WRITE_SNAPSHOTS === "1") {
    await mkdir(join(process.cwd(), SNAPSHOT_DIR), { recursive: true });
    await writeFile(expectedPath, pngBytes);
    return;
  }
  const expected = PNG.sync.read(await readFile(expectedPath));
  const actual = PNG.sync.read(Buffer.from(pngBytes));
  expect(actual.width).toBe(WIDTH);
  expect(actual.height).toBe(HEIGHT);
  expect(expected.width).toBe(WIDTH);
  expect(expected.height).toBe(HEIGHT);
  const mismatched = pixelmatch(actual.data, expected.data, null, WIDTH, HEIGHT, { threshold: 0 });
  expect(mismatched).toBe(0);
}

export function assertAllDistinct(pngs: Record<string, Uint8Array>): void {
  const hashes = Object.entries(pngs).map(([label, bytes]) => [label, hash(bytes)] as const);
  for (let left = 0; left < hashes.length; left++) {
    for (let right = left + 1; right < hashes.length; right++) {
      if (hashes[left]![1] === hashes[right]![1]) {
        throw new Error(`${hashes[left]![0]} and ${hashes[right]![0]} PNGs are byte-identical — camera positions are too symmetric`);
      }
    }
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
