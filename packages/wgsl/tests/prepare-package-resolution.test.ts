import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("built @vgpu/wgsl/prepare package entry", () => {
  test("resolves through actual Node 22 ESM and CommonJS package conditions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vgpu-wgsl-prepare-"));
    const scope = join(root, "node_modules", "@vgpu");
    await mkdir(scope, { recursive: true });
    await symlink(resolve("packages/wgsl"), join(scope, "wgsl"), "dir");
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const esmOutput = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import * as rootEntry from "@vgpu/wgsl"; import { prepareShader } from "@vgpu/wgsl/prepare"; console.log(JSON.stringify({ prepared: prepareShader("@compute @workgroup_size(1) fn main() {}"), rootHasPrepare: Object.hasOwn(rootEntry, "prepareShader") }));',
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(esmOutput)).toMatchObject({
      prepared: { version: 2, producer: "@vgpu/wgsl/prepare-v2" },
      rootHasPrepare: false,
    });

    const requireFromConsumer = createRequire(join(root, "consumer.cjs"));
    expect(requireFromConsumer.resolve("@vgpu/wgsl/prepare")).toBe(
      resolve("packages/wgsl/dist/prepare.js"),
    );
    expect(typeof requireFromConsumer("@vgpu/wgsl/prepare").prepareShader).toBe("function");
  });
});
