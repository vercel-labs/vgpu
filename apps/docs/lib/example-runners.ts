import { run as runGradient } from '../examples/gradient/example';
import { run as runTriangleLedGodRays } from '../examples/triangle-led-god-rays/example';

export type ExampleRunner = (canvas: HTMLCanvasElement) => Promise<() => void>;

export const exampleRunners = {
  gradient: runGradient,
  'triangle-led-god-rays': runTriangleLedGodRays,
} satisfies Record<string, ExampleRunner>;

export function getExampleRunner(slug: string): ExampleRunner | undefined {
  return exampleRunners[slug as keyof typeof exampleRunners];
}
