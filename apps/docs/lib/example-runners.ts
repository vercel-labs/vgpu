import { run as runGradient } from '../examples/gradient/example';
import { run as runTriangleLedFront } from '../examples/triangle-led-front/example';
import { run as runAntiAliasing } from '../examples/anti-aliasing/example';
import { run as runPostProcessing } from '../examples/post-processing/example';

export type ExampleRunner = (canvas: HTMLCanvasElement) => Promise<() => void>;

export const exampleRunners = {
  gradient: runGradient,
  'triangle-led-front': runTriangleLedFront,
  'anti-aliasing': runAntiAliasing,
  'post-processing': runPostProcessing,
} satisfies Record<string, ExampleRunner>;

export function getExampleRunner(slug: string): ExampleRunner | undefined {
  return exampleRunners[slug as keyof typeof exampleRunners];
}
