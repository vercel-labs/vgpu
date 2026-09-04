import { clock, effect, frameLoop, init, sampler, surface, target, type Target } from "vgpu";

import blurWgsl from "./shaders/blur.wgsl";
import compositeWgsl from "./shaders/composite.wgsl";
import fieldWgsl from "./shaders/field.wgsl";

const FORMAT = "rgba32float" as const;

export interface HeroRenderer {
  dispose(): void;
}

/**
 * Aurora field rendered to an HDR target, then a two-pass blur and a composite
 * that adds the glow back on top with tone mapping.
 */
export async function createHeroRenderer(canvas: HTMLCanvasElement): Promise<HeroRenderer> {
  // The blur and composite passes sample the 32-bit float intermediates with a
  // linear sampler, which WebGPU only allows with this optional feature.
  const gpu = await init({ requiredFeatures: ["float32-filterable"] });
  try {
    const output = surface(gpu, canvas, { dpr: [1, 2] });
    const [width, height] = output.size;

    const scene = target(gpu, { size: [width, height], format: FORMAT });
    const blurA = target(gpu, { size: [width, height], format: FORMAT });
    const blurB = target(gpu, { size: [width, height], format: FORMAT });
    const samp = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

    const field = effect(gpu, fieldWgsl, {
      set: { params: { time: 0, aspect: width / height } },
    });
    const blurH = effect(gpu, blurWgsl, {
      set: { samp, src: scene, blur: { texelSize: blurA.texelSize, direction: [1, 0] } },
    });
    const blurV = effect(gpu, blurWgsl, {
      set: { samp, src: blurA, blur: { texelSize: blurB.texelSize, direction: [0, 1] } },
    });
    const composite = effect(gpu, compositeWgsl, {
      set: { samp, scene, glow: blurB },
    });

    const resize = (size: readonly [number, number]) => {
      for (const t of [scene, blurA, blurB] as Target[]) t.resize(size);
      field.set({ params: { aspect: size[0] / size[1] } });
      blurH.set({ blur: { texelSize: blurA.texelSize } });
      blurV.set({ blur: { texelSize: blurB.texelSize } });
    };
    output.onResize((event) => resize([event.width, event.height]));

    const time = clock(gpu);
    frameLoop(gpu, (frame) => {
      field.set({ params: { time: time.time } });
      frame.pass(scene, field);
      frame.pass(blurA, blurH);
      frame.pass(blurB, blurV);
      frame.pass(output, composite);
    });

    return { dispose: () => gpu.dispose() };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}
