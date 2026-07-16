import { runFragmentExample, renderFragmentThumb } from '../_shared/render';
import type { Gpu, Target } from 'vgpu';
import fragment from './display.wgsl';

export interface FluidThumbOptions {
  readonly frames: number;
  readonly dt: number;
  readonly fragment?: string;
}

export function renderThumb(gpu: Gpu, target: Target, { frames, dt, fragment: fragmentSource = fragment }: FluidThumbOptions): void {
  renderFragmentThumb(gpu, target, { fragment: fragmentSource }, { time: frames * dt });
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  return runFragmentExample(canvas, { fragment });
}
