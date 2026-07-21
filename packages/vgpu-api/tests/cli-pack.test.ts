import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageDir, "../..");

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("vgpu owns the CLI bin and the internal CLI cannot be published", () => {
  const vgpu = readJson(resolve(packageDir, "package.json"));
  const cli = readJson(resolve(workspaceRoot, "packages/vgpu/package.json"));

  expect(vgpu.bin).toEqual({ vgpu: "./bin/vgpu.js" });
  expect(existsSync(resolve(packageDir, "bin/vgpu.js"))).toBe(true);
  expect(cli.name).toBe("@vgpu/cli");
  expect(cli.private).toBe(true);
});

test("the vgpu tarball includes the full internal CLI", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output.slice(output.indexOf("[")));
  const files = pack.files.map((file: { path: string }) => file.path);

  expect(files).toContain("bin/vgpu.js");
  expect(files).toContain("dist/cli/bin/vgpu.js");
  expect(files).toContain("dist/cli/lib/generated/docs-manifest.generated.js");
});
