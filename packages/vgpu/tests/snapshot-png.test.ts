import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { comparePngSnapshot, writePng } from "../lib/snapshot/png.js";
import { comparePixelSnapshot, writePixelSnapshot } from "../../vgpu-api/test-utils/snapshot.js";

const expected = new Uint8Array([0, 0, 0, 255]);
const actual = new Uint8Array([255, 255, 255, 255]);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vgpu-snapshot-png-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.each([
  { name: "CLI", compare: comparePngSnapshot, write: writePng, throwsOnMismatch: false },
  { name: "test utility", compare: comparePixelSnapshot, write: writePixelSnapshot, throwsOnMismatch: true },
])("$name snapshot comparison", ({ compare, write, throwsOnMismatch }) => {
  test.each([
    ["baseline.png", "baseline"],
    ["baseline.PNG", "baseline"],
    ["baseline", "baseline"],
    ["baseline.bin", "baseline.bin"],
  ])("preserves %s and writes distinct artifacts on mismatch", async (filename, stem) => {
    const baselinePath = join(root, filename);
    const actualPath = join(root, `${stem}.actual.png`);
    const diffPath = join(root, `${stem}.diff.png`);
    await write(baselinePath, expected, 1, 1);
    const baseline = await readFile(baselinePath);

    const comparison = compare(baselinePath, actual, 1, 1);
    if (throwsOnMismatch) {
      await expect(comparison).rejects.toThrow("Snapshot mismatch: 1 pixels differ");
    } else {
      await expect(comparison).resolves.toMatchObject({ status: "different", actualPath, diffPath });
    }

    expect(await readFile(baselinePath)).toEqual(baseline);
    expect(PNG.sync.read(await readFile(actualPath)).data).toEqual(Buffer.from(actual));
    const diff = PNG.sync.read(await readFile(diffPath));
    expect([diff.width, diff.height]).toEqual([1, 1]);
    expect(diff.data).not.toEqual(Buffer.from(actual));
    expect((await readdir(root)).sort()).toEqual([filename, `${stem}.actual.png`, `${stem}.diff.png`].sort());
  });

  test("matching pixels leave the baseline unchanged without diagnostic files", async () => {
    const path = join(root, "baseline.PNG");
    await write(path, expected, 1, 1);
    const baseline = await readFile(path);

    await expect(compare(path, expected, 1, 1)).resolves.toMatchObject({ status: "matched" });
    expect(await readFile(path)).toEqual(baseline);
    expect(await readdir(root)).toEqual(["baseline.PNG"]);
  });

  test("explicit update replaces the baseline without diagnostic files", async () => {
    const path = join(root, "baseline");
    await write(path, expected, 1, 1);

    await expect(compare(path, actual, 1, 1, { update: true })).resolves.toMatchObject({ status: "updated" });
    expect(PNG.sync.read(await readFile(path)).data).toEqual(Buffer.from(actual));
    expect(await readdir(root)).toEqual(["baseline"]);
  });
});
