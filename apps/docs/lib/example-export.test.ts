import { describe, expect, it } from "vitest";
import { portableExampleSource } from "./example-export";

describe("portableExampleSource", () => {
  it.each([
    "/examples/three-tsl/sunset.exr",
    "/examples/glass-fractal/rounded-tetrahedron.mesh?v=bevel-4",
    "/models/depth/fastdepth-320x256.onnx",
    "/ort/",
  ])("points the public asset %s at vgpu.sh", (path) => {
    expect(portableExampleSource(`const asset = "${path}";`)).toBe(
      `const asset = "https://vgpu.sh${path}";`,
    );
  });

  it("leaves imports, relative paths, and existing absolute URLs unchanged", () => {
    const source = `import shader from "./shader.wgsl";
const local = "/api/settings";
const remote = "https://vgpu.sh/models/example.onnx";
`;

    expect(portableExampleSource(source)).toBe(source);
  });
});
