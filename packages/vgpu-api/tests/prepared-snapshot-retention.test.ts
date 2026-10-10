import { expect, test } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("consumers of a long-lived prepared artifact collect after use or dispose while its snapshot keeps serving", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vgpu-prepared-retention-"));
  const outfile = join(directory, "prepared-snapshot-retention-gc.mjs");
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./prepared-snapshot-retention-gc.ts", import.meta.url))],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const probe = spawnSync(process.execPath, ["--expose-gc", outfile], { encoding: "utf8", timeout: 60_000 });
    expect(probe.status, `GC probe failed\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toEqual({ collected: 260, retained: true, reused: true, frozen: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
