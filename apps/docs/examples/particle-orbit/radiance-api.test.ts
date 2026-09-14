import { expect, test } from "vitest";
import {
  frame,
  getMockGPUDeviceInstrumentation,
  init,
  target,
} from "vgpu/mock";
import {
  createRadiance,
  destroyRadiance,
  setRadianceScene,
  setRadianceTime,
  type Radiance,
} from "./radiance";

test("the radiance emitter starts at time zero and retains animation when its scene is rebound", async () => {
  const gpu = await init();
  let radiance: Radiance | undefined;
  try {
    const scene = target(gpu, { size: [1000, 600], format: "rgba16float" });
    radiance = createRadiance(gpu, scene.size);
    setRadianceScene(radiance, scene);
    await radiance.effects.emitter.compile(radiance.emitter);
    frame(gpu, (current) =>
      current.pass({ target: radiance!.emitter }, (pass) =>
        pass.draw(radiance!.effects.emitter)
      )
    );
    await gpu.settled();

    const buffers = new Set<GPUBuffer>();
    for (const descriptor of getMockGPUDeviceInstrumentation(gpu.device.gpu)
      .createBindGroupDescriptors)
      for (const { resource } of descriptor.entries)
        if ("buffer" in resource && resource.buffer.label.endsWith(".params"))
          buffers.add(resource.buffer);
    expect(buffers.size).toBe(1);
    const buffer = [...buffers][0]!;
    if (
      !("__vgpuMockBytes" in buffer) ||
      !(buffer.__vgpuMockBytes instanceof Uint8Array)
    )
      throw new Error(
        "The public mock backend did not expose packed buffer bytes"
      );
    const bytes = buffer.__vgpuMockBytes;
    const values = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4
    );
    expect(radiance.emitter.size).toEqual([480, 288]);
    expect([...values]).toEqual([0, Math.fround(480 / 288)]);

    setRadianceTime(radiance, 7.25);
    setRadianceScene(
      radiance,
      target(gpu, { size: [500, 500], format: "rgba16float" })
    );
    expect([...values]).toEqual([7.25, Math.fround(480 / 288)]);
  } finally {
    if (radiance) destroyRadiance(radiance);
    gpu.dispose();
  }
});
