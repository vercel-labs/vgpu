import { runFragmentExample } from '../_shared/render';
import fragment from './display.wgsl';

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  return runFragmentExample(canvas, { fragment });
}
