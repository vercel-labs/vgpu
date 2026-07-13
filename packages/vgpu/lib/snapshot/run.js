import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { comparePngSnapshot } from "./png.js";
import { renderRepresentativeSnapshot } from "./render.js";

const DEFAULT_BASELINE = "packages/vgpu-api/tests/__snapshots__/representative-gradient.png";

export async function runSnapshotCommand(options = {}) {
  if (process.env.VGPU_DOCKER_TEST !== "1") {
    return { code: 1, stderr: "vgpu snapshot must run inside the Docker GPU harness with VGPU_DOCKER_TEST=1.\n" };
  }

  const { init } = await import("vgpu/node");
  const baselinePath = resolve(workspaceRoot(), options.baselinePath ?? DEFAULT_BASELINE);
  const rendered = await renderRepresentativeSnapshot(init);
  const result = await comparePngSnapshot(baselinePath, rendered.pixels, rendered.width, rendered.height);
  if (result.status === "different") {
    return { code: 1, stderr: `Snapshot mismatch: ${baselinePath} (${result.mismatchedPixels} pixels, ratio ${result.ratio})\n` };
  }
  const verb = result.status === "created" ? "created" : "matched";
  return { code: 0, stdout: `Snapshot ${verb}: ${baselinePath}\n` };
}

function workspaceRoot() {
  let current = process.cwd();
  while (!existsSync(resolve(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not find pnpm-workspace.yaml for vgpu snapshot");
    current = parent;
  }
  return current;
}
