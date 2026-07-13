import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { comparePngSnapshot, snapshotFixit } from "./png.js";
import { renderRepresentativeSnapshot } from "./render.js";

const DEFAULT_BASELINE = "packages/vgpu-api/tests/__snapshots__/representative-gradient.png";

export async function runSnapshotCommand(options = {}) {
  if (process.env.VGPU_DOCKER_TEST !== "1") {
    return { code: 1, stderr: "vgpu snapshot must run inside the Docker GPU harness with VGPU_DOCKER_TEST=1.\n" };
  }

  const parsed = parseSnapshotArgs(options.args ?? []);
  if (parsed.error) return { code: 1, stderr: `${parsed.error}\n${snapshotUsage()}` };

  const loaded = await loadNodeInit();
  if (loaded.error) return { code: 1, stderr: loaded.error };

  const baselinePath = resolve(workspaceRoot(), parsed.baselinePath ?? options.baselinePath ?? DEFAULT_BASELINE);
  const rendered = await renderRepresentativeSnapshot(loaded.init);
  const result = await comparePngSnapshot(baselinePath, rendered.pixels, rendered.width, rendered.height, { update: parsed.update });

  if (result.status === "missing") {
    return { code: 1, stderr: `Snapshot baseline is missing.\n${snapshotFixit(baselinePath, result.actualPath, result.diffPath)}\n` };
  }
  if (result.status === "different") {
    return { code: 1, stderr: `Snapshot mismatch: ${result.mismatchedPixels} pixels differ (ratio ${result.ratio}).\n${snapshotFixit(baselinePath, result.actualPath, result.diffPath)}\n` };
  }

  const verb = result.status === "created" ? "created" : result.status === "updated" ? "updated" : "matched";
  return { code: 0, stdout: `Snapshot ${verb}: ${baselinePath}\n` };
}

function parseSnapshotArgs(args) {
  const parsed = { update: false, baselinePath: undefined, error: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--update") {
      parsed.update = true;
    } else if (arg === "--ci") {
      parsed.update = false;
    } else if (arg === "--baseline") {
      const value = args[i + 1];
      if (value === undefined) return { ...parsed, error: "Missing value for --baseline" };
      parsed.baselinePath = value;
      i += 1;
    } else {
      return { ...parsed, error: `Unknown snapshot option: ${arg}` };
    }
  }
  if (process.env.CI === "true") parsed.update = false;
  return parsed;
}

function snapshotUsage() {
  return "Usage: vgpu snapshot [--ci] [--update] [--baseline <path>]\n";
}

async function loadNodeInit() {
  try {
    const { init } = await import("vgpu/node");
    return { init };
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return { error: "vgpu snapshot requires the peer package `vgpu` with its `vgpu/node` entry installed. Install it with `pnpm add vgpu` or run this command from the VGPU workspace.\n" };
  }
}

function workspaceRoot() {
  const initial = process.cwd();
  let current = initial;
  while (!existsSync(resolve(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
  return current;
}
