import { resolve } from "node:path";
import { expect, test } from "vitest";
import { captureToolEnvironment } from "../src/compiler/environment.ts";

test("capturing an explicit host environment owns its values and entry-time relative selections", () => {
  const environment = {
    TMPDIR: "relative-scratch",
    DEVELOPER_DIR: "relative-xcode",
    VGPU_CONTEXT_MARKER: "selected",
  };
  const expectedScratch = resolve(environment.TMPDIR);
  const expectedXcode = resolve(environment.DEVELOPER_DIR);
  const context = captureToolEnvironment(environment);
  expect(environment).toEqual({
    TMPDIR: "relative-scratch",
    DEVELOPER_DIR: "relative-xcode",
    VGPU_CONTEXT_MARKER: "selected",
  });
  environment.TMPDIR = "changed-scratch";
  environment.DEVELOPER_DIR = "changed-xcode";
  environment.VGPU_CONTEXT_MARKER = "changed";
  expect(context).toEqual({
    TMPDIR: expectedScratch,
    DEVELOPER_DIR: expectedXcode,
    VGPU_CONTEXT_MARKER: "selected",
  });
  expect(Object.isFrozen(context)).toBe(true);
});
