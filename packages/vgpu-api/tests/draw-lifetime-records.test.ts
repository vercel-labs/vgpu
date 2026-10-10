import { expect, test } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("dropped consumers release their lifetime records by finalization while retained controls only hit the cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vgpu-lifetime-records-"));
  const outfile = join(directory, "draw-lifetime-records-gc.mjs");
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./draw-lifetime-records-gc.ts", import.meta.url))],
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
      dropped: 120,
      collected: 120,
      ownersCollected: true,
      droppedRecordsTracked: true,
      recordsReturned: true,
      controlRecordsKept: true,
      maintenanceDuringHits: 0,
      createdDuringHits: 0,
      bufferListeners: 1,
      targetListeners: 1,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
