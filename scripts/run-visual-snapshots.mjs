import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSnapshotEnvironment, SNAPSHOT_ENV } from "./lib/visual-snapshot.mjs";

assertSnapshotEnvironment();
const artifactRoot = "artifacts/visual-snapshots";
await mkdir(artifactRoot, { recursive: true });
// Fresh reports prevent stale successes/candidates from a previous run being published.
if ((await readdir(artifactRoot)).length) throw new Error(`${artifactRoot} must be empty. Preserve previous artifacts in a different directory first.`);
const metadata = {
  environment: SNAPSHOT_ENV, mode: process.env.VGPU_SNAPSHOT_MODE,
  execution: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local (not native CI evidence)",
  revision: process.env.GITHUB_SHA ?? null, node: process.version,
  cpu: (await readFile("/proc/cpuinfo", "utf8")).split("\n\n")[0],
  cpuCaps: process.env.GALLIUM_OVERRIDE_CPU_CAPS, vectorWidth: process.env.LP_NATIVE_VECTOR_WIDTH,
  dockerfileSha256: createHash("sha256").update(await readFile("infra/snapshots/Dockerfile")).digest("hex"),
  lockfileSha256: createHash("sha256").update(await readFile("pnpm-lock.yaml")).digest("hex"),
  packages: spawnSync("dpkg-query", ["-W", "mesa-vulkan-drivers", "libllvm19", "libvulkan1"], { encoding: "utf8" }).stdout,
  vulkan: spawnSync("vulkaninfo", ["--summary"], { encoding: "utf8" }).stdout,
};
await writeFile(join(artifactRoot, "environment.json"), JSON.stringify(metadata, null, 2));
const run = spawnSync("pnpm", ["exec", "vitest", "run", "--maxWorkers=1", "--minWorkers=1",
  "packages/vgpu-api/tests/scene/primitives",
  "packages/render/tests/inspect/box-normals.test.ts",
  "packages/render/tests/inspect/box-wireframe.test.ts",
  "packages/render/tests/edit/operator-snapshots.test.ts",
  "packages/render/tests/edit/headline-pyramid-bevel.test.ts",
], { stdio: "inherit", env: { ...process.env, VGPU_DOCKER_TEST: "1", VGPU_VALIDATE: "require" } });
const reports = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name === "result.json") reports.push(JSON.parse(await readFile(path, "utf8")));
  }
}
await collect(artifactRoot);
reports.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(artifactRoot, "results.json"), JSON.stringify({ ...metadata, passed: run.status === 0 && reports.length > 0, images: reports }, null, 2));
const html = ['<!doctype html><meta charset="utf-8"><title>Visual snapshots</title>',
  '<style>body{font:14px system-ui;background:#181818;color:white}img{width:256px}article{margin:24px 0}code{display:block}</style>',
  `<h1>Visual snapshots</h1><p>${reports.filter((r) => r.status !== "matched").length} changed or missing / ${reports.length} images.</p><p>Before / Actual / Diff. Candidates are not approved references.</p>`,
  ...reports.map(({ path, status, baselineSha256, mismatchedPixels, maxChannelDelta }) => {
    const base = `images/${path.slice(0, -4)}`;
    const frames = [baselineSha256 && "before", "actual", mismatchedPixels !== null && "diff"].filter(Boolean);
    return `<details ${status !== "matched" ? "open" : ""}><summary>${path} — ${status}</summary><article><p>Changed pixels: ${mismatchedPixels ?? "n/a"}; max channel delta: ${maxChannelDelta ?? "n/a"}/255.</p>${frames.map((kind) => `<img alt="${kind}" src="${base}/${kind}.png">`).join("")}</article></details>`;
  }),
].join("\n");
await writeFile(join(artifactRoot, "index.html"), html);
console.log(`${reports.length} image reports: ${artifactRoot}/index.html`);
if (run.error) console.error(run.error);
process.exitCode = run.status === 0 && reports.length > 0 ? 0 : 1;
