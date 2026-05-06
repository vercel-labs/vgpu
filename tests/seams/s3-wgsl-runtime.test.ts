import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3", () => {
  test("5: simple two-file import resolves", async () => {
    const resolved = await resolveShader({
      entry: "/main.wgsl",
      validate: false,
      modules: {
        "/main.wgsl": `import { color } from "./palette.wgsl";
@fragment
fn fs_main() -> @location(0) vec4f {
  return color();
}`,
        "/palette.wgsl": `export fn color() -> vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}`,
      },
    });

    expect(resolved.wgsl).toContain("fn _vgsl_");
    expect(resolved.wgsl).toContain("return _vgsl_");
    expect(resolved.wgsl).toContain("fn fs_main(");
    expect(resolved.cacheKey.fs_main).toMatch(/^vgsl-1:[0-9a-f]{32}$/);
  });
});
