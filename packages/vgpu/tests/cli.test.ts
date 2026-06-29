import { expect, test } from "vitest";
import { runCli } from "../bin/vgpu.js";

function success(args) {
  const result = runCli(args);
  expect(result.code).toBe(0);
  expect(result.stderr).toBeUndefined();
  return result.stdout ?? "";
}

test("preserves root help, version, and placeholders", () => {
  expect(success(["--help"])).toContain("vgpu docs --help");
  expect(success(["--version"])).toMatch(/^0\.0\.7\n$/u);
  expect(runCli(["doctor"])).toMatchObject({ code: 1, stderr: expect.stringContaining("coming soon") });
  expect(runCli(["wgsl"])).toMatchObject({ code: 1, stderr: expect.stringContaining("coming soon") });
});

test("supports docs help and path listing", () => {
  expect(success(["docs", "help"])).toContain("Usage: vgpu docs <command>");
  expect(success(["docs", "ls"])).toContain("/@vgpu/core");
  expect(success(["docs", "ls", "/@vgpu/core"])).toContain("Buffer.docs.md");
});

test("cats docs by path and unique symbol", () => {
  expect(success(["docs", "cat", "/@vgpu/core/Buffer.docs.md"])).toContain("# Buffer");
  expect(success(["docs", "cat", "Buffer"])).toContain("# Buffer");
});

test("greps content with case and package options", () => {
  expect(success(["docs", "grep", "renderTargetForCanvas"])).toContain("renderTargetForCanvas");
  expect(runCli(["docs", "grep", "rendertargetforcanvas"]).code).toBe(1);
  const filtered = success(["docs", "grep", "-i", "--package", "@vgpu/wgsl", "MINIFY"]);
  expect(filtered).toContain("/@vgpu/wgsl/");
});

test("finds symbols and resolves paths", () => {
  expect(success(["docs", "find", "Buffer"])).toContain("Buffer\t@vgpu/core");
  expect(success(["docs", "path", "Buffer"])).toBe("/@vgpu/core/Buffer.docs.md\n");
  expect(success(["docs", "path", "/@vgpu/core/Buffer.docs.md"])).toBe("/@vgpu/core/Buffer.docs.md\n");
});

test("returns nonzero for missing and unknown docs commands", () => {
  expect(runCli(["docs", "cat", "MissingSymbol"])).toMatchObject({ code: 1, stderr: expect.stringContaining("Symbol not found") });
  expect(runCli(["docs", "nope"])).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown docs command") });
  expect(runCli(["nope"])).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown vgpu command") });
});
