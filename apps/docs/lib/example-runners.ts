import { run as runGradient } from '../examples/gradient/example';
import { run as runTriangleLedFront } from '../examples/triangle-led-front/example';

export type ExampleRunner = (canvas: HTMLCanvasElement) => Promise<() => void>;

export const exampleRunners = {
  gradient: runGradient,
  'triangle-led-front': runTriangleLedFront,
} satisfies Record<string, ExampleRunner>;

export function getExampleRunner(slug: string): ExampleRunner | undefined {
  return exampleRunners[slug as keyof typeof exampleRunners];
}
