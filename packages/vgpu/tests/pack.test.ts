import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { evaluateBudget, measuredTarballPayload, parseTarEntries, resolvePackageAudience, resolveThreshold } from "../../../scripts/lib/bundle-budgets.mjs";

const packageDir = new URL("..", import.meta.url).pathname;

test("dry-run pack includes bundled docs artifact", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output.slice(output.indexOf("[")));
  const files = pack.files.map((file) => file.path);

  expect(files).toContain("bin/vgpu.js");
  expect(files).toContain("lib/generated/docs-manifest.generated.js");
});

test("packed install exposes vgpu docs bin", () => {
  const packDir = mkdtempSync(join(tmpdir(), "vgpu-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "vgpu-install-"));
  try {
    execFileSync(
      "pnpm",
      ["pack", "--pack-destination", packDir],
      { cwd: packageDir, encoding: "utf8" }
    );
    // Use the same packer and payload as bundle-check; keep the CLI's zero-growth gate.
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const tarball = join(packDir, `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`);
    const entries = parseTarEntries(gunzipSync(readFileSync(tarball)));
    const measuredBytes = gzipSync(measuredTarballPayload(entries)).length;
    const verdict = evaluateBudget({
      measuredBytes,
      budgetBytes: manifest.vgpuBundleBudgetGzipBytes,
      audience: resolvePackageAudience(manifest),
      threshold: resolveThreshold(manifest),
    });
    expect(verdict.status, JSON.stringify(verdict)).toBe("ok");
    execFileSync("npm", ["install", tarball, "--prefix", installDir], {
      stdio: "pipe",
    });
    const bin = join(installDir, "node_modules/.bin/vgpu");
    const result = execFileSync(bin, ["docs", "path", "Buffer"], {
      encoding: "utf8",
    });
    expect(result).toBe("/vgpu/core/buffer.docs.md\n");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
}, 60_000);
