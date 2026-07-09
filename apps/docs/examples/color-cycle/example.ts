import { runFragmentExample } from '../_shared/render';
import fragment from './shader.wgsl';

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  return runFragmentExample(canvas, { fragment });
}
