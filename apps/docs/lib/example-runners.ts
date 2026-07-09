import { run as runGradient } from '../examples/gradient/example';
import { run as runWave } from '../examples/wave/example';
import { run as runColorCycle } from '../examples/color-cycle/example';
import { run as runRaymarching } from '../examples/raymarching/example';
import { run as runNoise } from '../examples/noise/example';
import { run as runMetaballs } from '../examples/metaballs/example';
import { run as runFractal } from '../examples/fractal/example';
import { run as runAlienPlanet } from '../examples/alien-planet/example';
import { run as runFluid } from '../examples/fluid/example';
import { run as runTriangleParticles } from '../examples/triangle-particles/example';

export type ExampleRunner = (canvas: HTMLCanvasElement) => Promise<() => void>;

export const exampleRunners = {
  gradient: runGradient,
  wave: runWave,
  'color-cycle': runColorCycle,
  raymarching: runRaymarching,
  noise: runNoise,
  metaballs: runMetaballs,
  fractal: runFractal,
  'alien-planet': runAlienPlanet,
  fluid: runFluid,
  'triangle-particles': runTriangleParticles,
} satisfies Record<string, ExampleRunner>;

export function getExampleRunner(slug: string): ExampleRunner | undefined {
  return exampleRunners[slug as keyof typeof exampleRunners];
}
