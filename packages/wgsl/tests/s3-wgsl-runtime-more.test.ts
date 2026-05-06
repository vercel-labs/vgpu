import { describe, expect, test } from "vitest";
import { compile } from "@vgpu/wgsl";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { hash8 } from "../src/runtime/mangler.ts";
import { scan } from "../src/runtime/scanner.ts";

describe("s3", () => {
  test("1: scanner emits comments atomically", () => {
    const tokens = scan("// import { x } from './x'\nlet color = 1;");
    expect(tokens[0]).toMatchObject({ kind: "lineComment" });
    expect(tokens.map((token) => token.text)).toContain("color");
  });

  test("22: mangled names stable for canonical path", async () => {
    expect(hash8("/project/shaders/palette.wgsl")).toBe("66db19c4");
    const opts = { entry: "/main.wgsl", validate: false, modules: { "/main.wgsl": "import { color } from './palette.wgsl'; @fragment fn main() -> @location(0) vec4f { return color(); }", "/palette.wgsl": "export fn color() -> vec4f { return vec4f(1.0); }" } };
    const first = await resolveShader(opts), second = await resolveShader({ ...opts });
    expect(first.wgsl.match(/_vgsl_[0-9a-f]{8}__color/g)?.[0]).toBe(second.wgsl.match(/_vgsl_[0-9a-f]{8}__color/g)?.[0]);
    expect(first.cacheKey).toEqual(second.cacheKey);
  });

  test("56: override constants NOT mangled", async () => {
    const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
      "/main.wgsl": "override SAMPLES: u32 = 4u;\n@compute @workgroup_size(1) fn main() { let x = SAMPLES; }",
    } });
    const overrideLines = resolved.wgsl.split("\n").filter((line) => line.includes("override"));
    expect(overrideLines.every((line) => !line.includes("_vgsl_"))).toBe(true);
  });

  test("67: cacheKey byte-equal across two compiles", async () => {
    const opts = { entry: "/main.wgsl", validate: false, modules: { "/main.wgsl": "@compute @workgroup_size(1) fn main() {}" } };
    await expect(resolveShader(opts)).resolves.toMatchObject({ cacheKey: { main: expect.stringMatching(/^vgsl-1:[0-9a-f]{32}$/) } });
    expect((await resolveShader(opts)).cacheKey).toEqual((await resolveShader(opts)).cacheKey);
  });

  test("75: comment-only import treated as plain WGSL", () => {
    const source = "// import { x } from './x.wgsl'\n@compute @workgroup_size(1) fn main() {}";
    expect(compile(source).wgsl).toBe(source);
  });
});
