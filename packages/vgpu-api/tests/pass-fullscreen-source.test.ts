import { expect, test } from "vitest";
import { fullscreenSource } from "../src/pass.ts";

test("fullscreenSource ignores @vertex text in comments", () => {
  const source = `
// @vertex fn fake() {}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}
`;

  expect(fullscreenSource(source)).toContain("@vertex fn vgpu_fullscreen_vs");
});
