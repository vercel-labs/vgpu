import { init } from 'vgpu';
import fragment from './shader.wgsl';

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const effect = gpu.effect(fragment);
  // TODO(vgpu): pre-warm the pipeline with effect.compile() once compile()/compileSync lands.
  const handle = gpu.frame.loop((frame) => {
    effect.set({
      uniforms: {
        time: gpu.time,
        resolution: surface.size,
        amplitude: 0.28,
        frequency: 8.0,
        color: [0.2, 0.8, 1.0],
      },
    });
    frame.pass({ target: surface }, (p) => p.draw(effect));
  });
  return () => { handle.stop(); gpu.dispose(); };
}
