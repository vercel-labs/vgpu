import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

function stdout(args: string[]): string {
  const result = runCli(args);
  expect(result.stderr).toBeUndefined();
  expect(result.code).toBe(0);
  return result.stdout ?? "";
}

test("prints docs help", () => {
  expect(stdout(["docs", "--help"])).toContain("Usage: vgpu docs <command>");
});

test("lists packages and package docs", () => {
  expect(stdout(["docs", "ls"])).toContain("/@vgpu/core");
  expect(stdout(["docs", "ls", "/@vgpu/core"])).toContain("Buffer.docs.md");
});

test("cats docs by path and symbol", () => {
  expect(stdout(["docs", "cat", "/@vgpu/core/Buffer.docs.md"])).toContain("# Buffer");
  expect(stdout(["docs", "cat", "Buffer"])).toContain("# Buffer");
});

test("greps globally and by package", () => {
  expect(stdout(["docs", "grep", "renderTargetForCanvas"])).toContain("renderTargetForCanvas");
  const filtered = stdout(["docs", "grep", "--package", "@vgpu/wgsl", "minify"]);
  expect(filtered).toContain("/@vgpu/wgsl/");
  expect(filtered).toContain("minify");
});

test("finds symbols, resolves paths, and lists symbols", () => {
  expect(stdout(["docs", "find", "Buffer"])).toContain("Buffer\t@vgpu/core");
  expect(stdout(["docs", "path", "Buffer"])).toBe("/@vgpu/core/Buffer.docs.md\n");
  expect(stdout(["docs", "symbols"])).toContain("Buffer\t@vgpu/core");
});

test("returns nonzero on missing docs", () => {
  const result = runCli(["docs", "cat", "MissingSymbol"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Symbol not found");
});
