import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

test("examples CLI stays dependency-free and within its separate size budget", () => {
  const output = execFileSync(process.execPath, [resolve(root, "scripts/check-examples-cli-size.mjs")], { encoding: "utf8" });
  expect(output).toMatch(/examples CLI: \d+ B unpacked \/ \d+ B gzip/);
  expect(existsSync(resolve(root, "packages/vgpu/lib/examples/run.js"))).toBe(true);
});
