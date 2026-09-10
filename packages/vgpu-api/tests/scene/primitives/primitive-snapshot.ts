import { createHash } from "node:crypto";
import { compareVisualSnapshot } from "../../../../../scripts/lib/visual-snapshot.mjs";
import { expect } from "vitest";
const SNAPSHOT_DIR = "packages/vgpu-api/tests/scene/primitives/__snapshots__";

export async function expectSnapshot(name: string, pngBytes: Uint8Array): Promise<void> {
  await compareVisualSnapshot(SNAPSHOT_DIR, name, pngBytes, { onMismatch: (message: string) => expect.soft(false, message).toBe(true) });
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
