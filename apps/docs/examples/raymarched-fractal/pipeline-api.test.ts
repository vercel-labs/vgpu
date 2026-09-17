import { expect, test } from "vitest";
import { frame, init, target } from "vgpu/mock";
import { uniformBindingFloats } from "../../test-support/mock-uniforms";
import {
  compileScene,
  createScene,
  destroyScene,
  renderScene,
  replaceTargets,
  type FractalScene,
} from "./pipeline";

test("the fractal initializes complete uniforms and preserves orbit across target replacement", async () => {
  const gpu = await init();
  let scene: FractalScene | undefined;
  try {
    const output = target(gpu, { size: [1280, 720] });
    scene = createScene(gpu, output.size);
    await compileScene(scene, output);
    frame(gpu, (current) =>
      renderScene(current, scene!, output, { yaw: 1.2, pitch: -0.4 })
    );
    await gpu.settled();
    expect(uniformBindingFloats(gpu, "raymarched-fractal-scene")).toEqual([
      [1280, 720, Math.fround(1.2), Math.fround(-0.4)],
    ]);
    expect(
      uniformBindingFloats(gpu, [
        "raymarched-fractal-blur-h",
        "raymarched-fractal-blur-v",
      ])
    ).toEqual([
      [Math.fround(1 / 640), Math.fround(1 / 360), 1, 0],
      [Math.fround(1 / 640), Math.fround(1 / 360), 0, 1],
    ]);

    replaceTargets(gpu, scene, [800, 500]);
    expect(scene.targets.scene.size).toEqual([800, 500]);
    expect(scene.targets.bloomA.size).toEqual([576, 360]);
    frame(gpu, (current) =>
      renderScene(current, scene!, output, { yaw: 1.2, pitch: -0.4 })
    );
    await gpu.settled();
    expect(uniformBindingFloats(gpu, "raymarched-fractal-scene")).toEqual([
      [800, 500, Math.fround(1.2), Math.fround(-0.4)],
    ]);
    expect(
      uniformBindingFloats(gpu, [
        "raymarched-fractal-blur-h",
        "raymarched-fractal-blur-v",
      ])
    ).toEqual([
      [Math.fround(1 / 576), Math.fround(1 / 360), 1, 0],
      [Math.fround(1 / 576), Math.fround(1 / 360), 0, 1],
    ]);
  } finally {
    if (scene) destroyScene(scene);
    gpu.dispose();
  }
});
