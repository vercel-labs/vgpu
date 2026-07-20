import type { Bundle, Gpu, Surface, Target } from 'vgpu';
import type { StirInput } from './controls';
import { GRID_HEIGHT, GRID_WIDTH, idleEmitters } from './math';
import advectVelocityWgsl from './advect-velocity.wgsl';
import divergenceWgsl from './divergence.wgsl';
import pressureWgsl from './pressure.wgsl';
import projectWgsl from './project.wgsl';
import advectDyeWgsl from './advect-dye.wgsl';
import displayWgsl from './display.wgsl';

const CELLS = GRID_WIDTH * GRID_HEIGHT;
const CLEAR = [0.003, 0.005, 0.014, 1] as const;
type Output = Surface | Target;
type StoragePair = ReturnType<Gpu['pingPongStorage']>;

export interface Fluid {
  gpu: Gpu;
  velocity: StoragePair;
  dye: StoragePair;
  pressure: StoragePair;
  divergence: ReturnType<Gpu['storage']>;
  passes: ReturnType<typeof createPasses>;
  bundles?: [Bundle, Bundle];
  output?: Output;
  step: number;
  lastInputStep: number;
}

export function createFluid(gpu: Gpu): Fluid {
  const velocity = gpu.pingPongStorage(CELLS * 8);
  const dye = gpu.pingPongStorage(CELLS * 16);
  const pressure = gpu.pingPongStorage(CELLS * 4);
  const divergence = gpu.storage(CELLS * 4, 'read-write');
  return { gpu, velocity, dye, pressure, divergence, passes: createPasses(gpu), step: 0, lastInputStep: -1000 };
}

function createPasses(gpu: Gpu) {
  return {
    advectVelocity: gpu.compute(advectVelocityWgsl),
    divergence: gpu.compute(divergenceWgsl),
    pressure: gpu.compute(pressureWgsl),
    project: gpu.compute(projectWgsl),
    advectDye: gpu.compute(advectDyeWgsl),
    display: [gpu.effect(displayWgsl), gpu.effect(displayWgsl)] as const,
  };
}

export async function prepareFluid(fluid: Fluid, output: Output): Promise<void> {
  const sim = { ...uniforms(fluid), output_size: output.size };
  fluid.passes.display[0].set({ sim, dye: fluid.dye.read });
  fluid.passes.display[1].set({ sim, dye: fluid.dye.write });
  await Promise.all(fluid.passes.display.map((display) => display.compile(output)));
  fluid.bundles = [0, 1].map((parity) => fluid.gpu.bundle({ target: output }, (bundle) => {
    bundle.draw(fluid.passes.display[parity]!);
  })) as [Bundle, Bundle];
  fluid.output = output;
}

export function stepFluid(fluid: Fluid, input?: StirInput): void {
  if (input?.active) fluid.lastInputStep = fluid.step;
  const sim = uniforms(fluid, input);
  const p = fluid.passes;

  p.advectVelocity.set({ sim, src: fluid.velocity.read, dst: fluid.velocity.write }).dispatch(16, 9);
  fluid.velocity.swap();

  p.divergence.set({ sim, velocity: fluid.velocity.read, divergence: fluid.divergence }).dispatch(16, 9);
  for (let i = 0; i < 8; i++) {
    p.pressure.set({ sim, src: fluid.pressure.read, divergence: fluid.divergence, dst: fluid.pressure.write }).dispatch(16, 9);
    fluid.pressure.swap();
  }

  p.project.set({ sim, src: fluid.velocity.read, pressure: fluid.pressure.read, dst: fluid.velocity.write }).dispatch(16, 9);
  fluid.velocity.swap();

  p.advectDye.set({ sim, src: fluid.dye.read, velocity: fluid.velocity.read, dst: fluid.dye.write }).dispatch(16, 9);
  fluid.dye.swap();
  fluid.step++;
  input?.consumeStep();
}

export function renderFluid(fluid: Fluid, output: Output): void {
  if (!fluid.bundles || fluid.output !== output) return;
  fluid.gpu.frame((frame) => frame.pass({ target: output, clear: CLEAR }, (pass) => {
    pass.bundles(fluid.bundles![fluid.step & 1]);
  }));
}

function uniforms(fluid: Fluid, input?: StirInput) {
  const time = fluid.step / 60;
  const [a, b] = idleEmitters(fluid.step);
  const sinceInput = fluid.step - fluid.lastInputStep;
  const idle = sinceInput < 90 ? 0.15 : 0.15 + 0.85 * Math.min(1, (sinceInput - 90) / 60);
  const ramp = Math.min(1, (fluid.step + 1) / 24);
  let pointerVelocity = input?.velocity ?? [0, 0] as [number, number];
  if (input?.active && Math.hypot(...pointerVelocity) < 0.02) {
    pointerVelocity = [0.16 * Math.cos(time * 5), 0.16 * Math.sin(time * 5)];
  }
  const colors = [[0.05, 0.55, 1, 1], [0.65, 0.15, 1, 1], [1, 0.22, 0.12, 1]] as const;
  return {
    size: [GRID_WIDTH, GRID_HEIGHT], step: fluid.step,
    pointer_active: input?.active ? 1 : 0,
    pointer_from: input?.from ?? [0.5, 0.5], pointer_to: input?.to ?? [0.5, 0.5],
    pointer_velocity: pointerVelocity,
    pointer_color: colors[(Math.floor(fluid.step / 90) + (input?.stroke ?? 0)) % colors.length]!,
    idle_a: [...a, ramp * idle, 0.085], idle_b: [...b, ramp * idle, 0.08],
    output_size: [1, 1], _pad: [0, 0],
  };
}
