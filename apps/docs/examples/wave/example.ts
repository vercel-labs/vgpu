import { runFragmentExample } from '../_shared/render';
import fragment from './shader.wgsl';

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  return runFragmentExample(canvas, {
    fragment,
    uniforms: { amplitude: 'f32', frequency: 'f32', color: 'vec3f' },
    values: () => ({ amplitude: 0.28, frequency: 8.0, color: [0.2, 0.8, 1.0] }),
  });
}
