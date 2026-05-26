import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expect, test } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");

test("packed package exposes executable docs bin", () => {
  const destination = mkdtempSync(join(tmpdir(), "vgpu-pack-"));
  try {
    const output = execFileSync("pnpm", ["--dir", packageDir, "pack", "--pack-destination", destination], { encoding: "utf8" });
    const tarball = output.trim().split(/\r?\n/u).at(-1);
    expect(tarball).toMatch(/vgpu-.*\.tgz$/u);
    const tarballPath = isAbsolute(tarball!) ? tarball! : join(destination, tarball!);

    const installDir = mkdtempSync(join(tmpdir(), "vgpu-install-"));
    try {
      execFileSync("npm", ["install", tarballPath, "--prefix", installDir], { stdio: "pipe" });
      const docs = execFileSync(join(installDir, "node_modules/.bin/vgpu"), ["docs", "path", "Buffer"], { encoding: "utf8" });
      expect(docs).toBe("/@vgpu/core/Buffer.docs.md\n");
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}, 60_000);
