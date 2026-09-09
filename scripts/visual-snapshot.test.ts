import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PNG } from "pngjs";
import { assertSnapshotEnvironment, compareVisualSnapshot, SNAPSHOT_ENV, SNAPSHOT_ROOTS, snapshotPath } from "./lib/visual-snapshot.mjs";

const env = {
  VGPU_SNAPSHOT_MODE: "check", VGPU_SNAPSHOT_ENV: SNAPSHOT_ENV, VGPU_DAWN_FLAGS: "backend=vulkan",
  VK_DRIVER_FILES: "/usr/share/vulkan/icd.d/lvp_icd.json", VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/lvp_icd.json",
  GALLIUM_OVERRIDE_CPU_CAPS: "nosse", LP_NATIVE_VECTOR_WIDTH: "128",
};
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("the canonical environment is explicit and legacy update flags cannot bypass review", () => {
  expect(() => assertSnapshotEnvironment(env, "linux", "x64")).not.toThrow();
  for (const changes of [{ VGPU_SNAPSHOT_ENV: undefined }, { VGPU_DAWN_FLAGS: "backend=opengl" }, { VK_DRIVER_FILES: "hardware.json" }, { VGPU_WRITE_SNAPSHOTS: "1" }, { VGPU_SNAPSHOT_MODE: "typo" }]) {
    expect(() => assertSnapshotEnvironment({ ...env, ...changes }, "linux", "x64")).toThrow();
  }
  expect(() => assertSnapshotEnvironment(env, "linux", "arm64")).toThrow();
  expect(() => assertSnapshotEnvironment(env, "darwin", "x64")).toThrow();
  for (const changes of [{ GALLIUM_OVERRIDE_CPU_CAPS: undefined }, { GALLIUM_OVERRIDE_CPU_CAPS: "sse2" }, { GALLIUM_OVERRIDE_CPU_CAPS: "avx" }, { LP_NATIVE_VECTOR_WIDTH: "256" }]) {
    expect(() => assertSnapshotEnvironment({ ...env, ...changes }, "linux", "x64")).toThrow();
  }
});

test("only known baseline directories and plain PNG names are accepted", () => {
  expect(snapshotPath(SNAPSHOT_ROOTS[0], "capsule-pbr-iso.png")).toContain("capsule-pbr-iso.png");
  for (const name of ["../outside.png", "/outside.png", "a/b.png", "a\\b.png", "<img>.png"]) {
    expect(() => snapshotPath(SNAPSHOT_ROOTS[0], name)).toThrow();
  }
  expect(() => snapshotPath("outside", "image.png")).toThrow();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vgpu-visual-")); directories.push(root);
  const directory = SNAPSHOT_ROOTS[0], name = "test.png";
  await mkdir(join(root, directory), { recursive: true });
  const baseline = png(40);
  await writeFile(join(root, directory, name), baseline);
  return { root, directory, name, baseline, options: { root, env, platform: "linux", arch: "x64" } };
}
function png(red: number, width = 256) {
  const image = new PNG({ width, height: 256 });
  for (let i = 0; i < image.data.length; i += 4) { image.data[i] = red; image.data[i + 3] = 255; }
  return PNG.sync.write(image);
}

test("matching pixels produce a report without modifying the baseline", async () => {
  const f = await fixture();
  expect(await compareVisualSnapshot(f.directory, f.name, f.baseline, f.options)).toMatchObject({ status: "matched" });
  expect(await readFile(join(f.root, f.directory, f.name))).toEqual(f.baseline);
});

test("even one channel level fails check and produces before, actual and diff", async () => {
  const f = await fixture();
  const changed = PNG.sync.read(f.baseline); changed.data[0] += 1;
  await expect(compareVisualSnapshot(f.directory, f.name, PNG.sync.write(changed), f.options)).rejects.toThrow("changed visual snapshot");
  const artifact = join(f.root, "artifacts/visual-snapshots/images", f.directory, "test");
  for (const file of ["before.png", "actual.png", "diff.png", "result.json"]) expect((await readFile(join(artifact, file))).length).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(artifact, "result.json"), "utf8"))).toMatchObject({ mismatchedPixels: 1, maxChannelDelta: 1 });
  expect(await readFile(join(f.root, f.directory, f.name))).toEqual(f.baseline);
});

test("update stages a candidate and baseline hashes, never overwrites approved PNGs", async () => {
  const f = await fixture();
  const actual = png(41);
  const result = await compareVisualSnapshot(f.directory, f.name, actual, { ...f.options, env: { ...env, VGPU_SNAPSHOT_MODE: "update" } });
  expect(result.baselineSha256).not.toBe(result.actualSha256);
  expect(await readFile(join(f.root, f.directory, f.name))).toEqual(f.baseline);
  expect(await readFile(join(f.root, "artifacts/visual-snapshots/candidates", f.directory, f.name))).toEqual(actual);
});

test("soft comparison failures allow the battery to collect all images without losing failure status", async () => {
  const f = await fixture();
  const failures: string[] = [];
  const result = await compareVisualSnapshot(f.directory, f.name, png(41), { ...f.options, onMismatch: (message: string) => failures.push(message) });
  expect(failures).toHaveLength(1);
  expect(result.status).toBe("changed");
  expect(await readFile(join(f.root, "artifacts/visual-snapshots/candidates", f.directory, f.name))).toEqual(png(41));
});

test("a missing reference fails check but can be generated as a review candidate", async () => {
  const f = await fixture();
  await expect(compareVisualSnapshot(f.directory, "new.png", f.baseline, f.options)).rejects.toThrow("missing visual snapshot");
  expect(await compareVisualSnapshot(f.directory, "new.png", f.baseline, { ...f.options, env: { ...env, VGPU_SNAPSHOT_MODE: "update" } })).toMatchObject({ status: "missing", baselineSha256: null });
  await expect(readFile(join(f.root, f.directory, "new.png"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("wrong render dimensions and corrupt PNGs are not accepted even in update mode", async () => {
  const f = await fixture();
  const options = { ...f.options, env: { ...env, VGPU_SNAPSHOT_MODE: "update" } };
  await expect(compareVisualSnapshot(f.directory, f.name, png(40, 128), options)).rejects.toThrow("256x256");
  await expect(compareVisualSnapshot(f.directory, f.name, Buffer.from("broken"), options)).rejects.toThrow();
});
