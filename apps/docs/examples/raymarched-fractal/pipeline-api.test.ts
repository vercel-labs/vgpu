import { expect, test } from "vitest";
import {
  frame,
  getMockGPUDeviceInstrumentation,
  init,
  target,
  type Gpu,
} from "vgpu/mock";
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
    expect(bindingFloats(gpu, ".params")).toEqual([
      [1280, 720, Math.fround(1.2), Math.fround(-0.4)],
    ]);
    expect(bindingFloats(gpu, ".blur")).toEqual([
      [Math.fround(1 / 640), Math.fround(1 / 360), 1, 0],
      [Math.fround(1 / 640), Math.fround(1 / 360), 0, 1],
    ]);

    replaceTargets(gpu, scene, [800, 500]);
    expect(scene.targets.scene.size).toEqual([800, 500]);
    expect(scene.targets.bloomA.size).toEqual([576, 360]);
    expect(bindingFloats(gpu, ".params")).toEqual([
      [800, 500, Math.fround(1.2), Math.fround(-0.4)],
    ]);
    expect(bindingFloats(gpu, ".blur")).toEqual([
      [Math.fround(1 / 576), Math.fround(1 / 360), 1, 0],
      [Math.fround(1 / 576), Math.fround(1 / 360), 0, 1],
    ]);
  } finally {
    if (scene) destroyScene(scene);
    gpu.dispose();
  }
});

function bindingFloats(gpu: Gpu, suffix: string): number[][] {
  const buffers = new Set<GPUBuffer>();
  for (const descriptor of getMockGPUDeviceInstrumentation(gpu.device.gpu)
    .createBindGroupDescriptors)
    for (const { resource } of descriptor.entries)
      if ("buffer" in resource && resource.buffer.label.endsWith(suffix))
        buffers.add(resource.buffer);
  return [...buffers].map((buffer) => {
    if (
      !("__vgpuMockBytes" in buffer) ||
      !(buffer.__vgpuMockBytes instanceof Uint8Array)
    )
      throw new Error(
        "The public mock backend did not expose packed buffer bytes"
      );
    const bytes = buffer.__vgpuMockBytes;
    return [
      ...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    ];
  });
}
