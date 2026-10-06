import { expect, test } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("abandoned render and compute consumers collect while resources and controls stay live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vgpu-draw-retention-"));
  const outfile = join(directory, "draw-retention-gc.mjs");
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./draw-retention-gc.ts", import.meta.url))],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const probe = spawnSync(process.execPath, ["--expose-gc", outfile], { encoding: "utf8", timeout: 60_000 });
    expect(probe.status, `GC probe failed\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toEqual({
      collected: 358,
      pendingCollected: true,
      retained: true,
      disposedRetained: true,
      releasedDisposedMetadata: true,
      releasedDisposedComputeConstructorSet: true,
      retainedDisposedBundle: true,
      ownerShardCollected: true,
      bindGroupCollected: true,
      textureListeners: 1,
      targetListeners: 1,
      bufferListeners: 1,
      recreateListeners: 0,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
