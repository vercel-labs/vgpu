import { init, type Gpu, type Target } from 'vgpu';
import fragment from './display.wgsl';

export interface FluidThumbOptions {
  readonly frames: number;
  readonly dt: number;
}

export function renderThumb(gpu: Gpu, target: Target, { frames, dt }: FluidThumbOptions): void {
  const effect = gpu.effect(fragment);
  effect.set({ uniforms: { time: frames * dt, resolution: target.size } });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(effect)));
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const effect = gpu.effect(fragment);
  // TODO(vgpu): pre-warm the pipeline with effect.compile() once compile()/compileSync lands.
  const handle = gpu.frame.loop((frame) => {
    effect.set({ uniforms: { time: gpu.time, resolution: surface.size } });
    frame.pass({ target: surface }, (p) => p.draw(effect));
  });
  return () => { handle.stop(); gpu.dispose(); };
}
