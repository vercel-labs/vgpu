import { run as runGradient } from '../examples/gradient/example';

export type ExampleRunner = (canvas: HTMLCanvasElement) => Promise<() => void>;

export const exampleRunners = {
  gradient: runGradient,
} satisfies Record<string, ExampleRunner>;

export function getExampleRunner(slug: string): ExampleRunner | undefined {
  return exampleRunners[slug as keyof typeof exampleRunners];
}
