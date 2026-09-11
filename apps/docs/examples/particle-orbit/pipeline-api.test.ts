import { expect, test } from "vitest";
import {
  frame,
  getMockGPUDeviceInstrumentation,
  init,
  storage,
  target,
  type Gpu,
} from "vgpu/mock";
import {
  createEffects,
  createTargets,
  destroyTargets,
  DUST_COUNT,
  prewarm,
  recordScene,
  renderChain,
  setBindings,
  setPointer,
  setTime,
  type Targets,
} from "./pipeline";
import {
  createRadiance,
  destroyRadiance,
  prewarmRadiance,
  type Radiance,
} from "./radiance";

test("particle effects start with complete uniforms and retain time and pointer on resize", async () => {
  const gpu = await init();
  let targets: Targets | undefined;
  let resized: Targets | undefined;
  let radiance: Radiance | undefined;
  try {
    const output = target(gpu, { size: [320, 180] });
    targets = createTargets(gpu, output.size);
    const effects = createEffects(gpu, targets);
    radiance = createRadiance(gpu, output.size);
    effects.stars.set({ particles: storage(gpu, DUST_COUNT * 48) });
    setBindings(effects, targets, radiance);
    await Promise.all([
      prewarm(effects, targets, output),
      prewarmRadiance(radiance),
    ]);
    const recorded = recordScene(gpu, effects);
    frame(gpu, (current) =>
      renderChain(current, effects, targets!, output, recorded, radiance!)
    );
    await gpu.settled();
    const params = bindingFloats(gpu, ".params");
    expect(params.filter((values) => values.length === 2)).toEqual(
      Array.from({ length: 5 }, () => [0, Math.fround(320 / 180)])
    );
    expect(params.filter((values) => values.length === 4)).toEqual([
      [0, Math.fround(320 / 180), 0, 0],
    ]);
    expect(bindingFloats(gpu, ".blur")).toEqual(expectedBlurs(320, 180));

    setTime(effects, radiance, 7.25);
    setPointer(effects, [0.25, -0.5]);
    resized = createTargets(gpu, [800, 500]);
    setBindings(effects, resized, radiance);
    const after = bindingFloats(gpu, ".params");
    expect(
      after.filter(
        (values) => values.length === 2 && values[1] === Math.fround(800 / 500)
      )
    ).toEqual(Array.from({ length: 4 }, () => [7.25, Math.fround(800 / 500)]));
    expect(
      after.filter(
        (values) => values.length === 2 && values[1] === Math.fround(320 / 180)
      )
    ).toEqual([[7.25, Math.fround(320 / 180)]]);
    expect(after.filter((values) => values.length === 4)).toEqual([
      [7.25, Math.fround(800 / 500), 0.25, -0.5],
    ]);
    expect(resized.bloom[0].size).toEqual([576, 360]);
    expect(bindingFloats(gpu, ".blur")).toEqual(expectedBlurs(576, 360));
  } finally {
    if (radiance) destroyRadiance(radiance);
    if (resized) destroyTargets(resized);
    if (targets) destroyTargets(targets);
    gpu.dispose();
  }
});

function expectedBlurs(width: number, height: number): number[][] {
  return [
    [1, 0, 1],
    [0, 1, 1],
    [1, 0, 2.4],
    [0, 1, 2.4],
  ].map(([x, y, radius]) => [
    Math.fround(1 / width),
    Math.fround(1 / height),
    x!,
    y!,
    Math.fround(radius!),
    0,
  ]);
}

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
