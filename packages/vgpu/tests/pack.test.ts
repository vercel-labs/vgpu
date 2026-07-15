import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const packageDir = new URL("..", import.meta.url).pathname;

test("dry-run pack includes bundled docs artifact", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir, encoding: "utf8" });
  const [pack] = JSON.parse(output.slice(output.indexOf("[")));
  const files = pack.files.map((file) => file.path);

  expect(files).toContain("bin/vgpu.js");
  expect(files).toContain("lib/generated/docs-manifest.generated.js");
  expect(pack.size).toBeLessThan(700_000);
});

test("packed install exposes vgpu docs bin", () => {
  const packDir = mkdtempSync(join(tmpdir(), "vgpu-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "vgpu-install-"));
  try {
    const output = execFileSync("npm", ["pack", "--pack-destination", packDir], { cwd: packageDir, encoding: "utf8" });
    const tarball = join(packDir, output.trim().split(/\r?\n/u).at(-1));
    execFileSync("npm", ["install", tarball, "--prefix", installDir], { stdio: "pipe" });
    const bin = join(installDir, "node_modules/.bin/vgpu");
    const result = execFileSync(bin, ["docs", "path", "Buffer"], { encoding: "utf8" });
    expect(result).toBe("/vgpu/core/Buffer.docs.md\n");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
}, 60_000);
