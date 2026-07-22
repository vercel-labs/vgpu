import type { Bundle, Gpu, Surface, Target } from 'vgpu';
import type { StirInput } from './controls';
import { GRID_HEIGHT, GRID_WIDTH, idleEmitters } from './math';
import advectVelocityWgsl from './advect-velocity.wgsl';
import curlWgsl from './curl.wgsl';
import vorticityWgsl from './vorticity.wgsl';
import divergenceWgsl from './divergence.wgsl';
import pressureWgsl from './pressure.wgsl';
import projectWgsl from './project.wgsl';
import advectDyeWgsl from './advect-dye.wgsl';
import displayWgsl from './display.wgsl';

const CELLS = GRID_WIDTH * GRID_HEIGHT;
const DYE_WIDTH = GRID_WIDTH * 4;
const DYE_HEIGHT = GRID_HEIGHT * 4;
const DYE_CELLS = DYE_WIDTH * DYE_HEIGHT;
const CLEAR = [0.003, 0.005, 0.014, 1] as const;
type Output = Surface | Target;
type StoragePair = ReturnType<Gpu['pingPongStorage']>;

export interface Fluid {
  gpu: Gpu;
  velocity: StoragePair;
  dye: StoragePair;
  pressure: StoragePair;
  divergence: ReturnType<Gpu['storage']>;
  curl: ReturnType<Gpu['storage']>;
  passes: ReturnType<typeof createPasses>;
  bundles?: [Bundle, Bundle];
  output?: Output;
  step: number;
  lastInputStep: number;
}

export function createFluid(gpu: Gpu): Fluid {
  const velocity = gpu.pingPongStorage(CELLS * 8);
  const dye = gpu.pingPongStorage(DYE_CELLS * 16);
  const pressure = gpu.pingPongStorage(CELLS * 4);
  const divergence = gpu.storage(CELLS * 4, 'read-write');
  const curl = gpu.storage(CELLS * 4, 'read-write');
  const passes = createPasses(gpu);
  return { gpu, velocity, dye, pressure, divergence, curl, passes, step: 0, lastInputStep: -1000 };
}

function createPasses(gpu: Gpu) {
  return {
    advectVelocity: gpu.compute(advectVelocityWgsl),
    curl: gpu.compute(curlWgsl),
    vorticity: gpu.compute(vorticityWgsl),
    divergence: gpu.compute(divergenceWgsl),
    pressure: gpu.compute(pressureWgsl),
    project: gpu.compute(projectWgsl),
    advectDye: gpu.compute(advectDyeWgsl),
    display: [gpu.effect(displayWgsl), gpu.effect(displayWgsl)] as const,
  };
}

export async function prepareFluid(fluid: Fluid, output: Output): Promise<void> {
  const grid = {
    size: [GRID_WIDTH, GRID_HEIGHT],
    dye_size: [DYE_WIDTH, DYE_HEIGHT],
    aspect: output.size[0] / Math.max(1, output.size[1]),
    _pad0: 0,
    _pad1: [0, 0],
  };
  fluid.passes.advectVelocity.set({ grid });
  fluid.passes.curl.set({ grid });
  fluid.passes.vorticity.set({ grid });
  fluid.passes.divergence.set({ grid });
  fluid.passes.pressure.set({ grid });
  fluid.passes.project.set({ grid });
  fluid.passes.advectDye.set({ grid });

  const config = { dye_size: [DYE_WIDTH, DYE_HEIGHT], output_size: output.size };
  fluid.passes.display[0].set({ config, dye: fluid.dye.read });
  fluid.passes.display[1].set({ config, dye: fluid.dye.write });
  await Promise.all(fluid.passes.display.map((display) => display.compile({ colors: [output.format] })));
  fluid.bundles = [0, 1].map((parity) => fluid.gpu.bundle({ target: { colors: [output.format] } }, (bundle) => {
    bundle.draw(fluid.passes.display[parity]!);
  })) as [Bundle, Bundle];
  fluid.output = output;
}

export function stepFluid(fluid: Fluid, input?: StirInput): void {
  if (input?.active) fluid.lastInputStep = fluid.step;
  const dynamic = inputUniforms(fluid, input);
  const p = fluid.passes;

  p.advectVelocity.set({ input: dynamic, src: fluid.velocity.read, dst: fluid.velocity.write }).dispatch(16, 9);
  fluid.velocity.swap();

  // Confinement restores the small rotating details lost by semi-Lagrangian advection.
  p.curl.set({ velocity: fluid.velocity.read, curl: fluid.curl }).dispatch(16, 9);
  p.vorticity.set({ src: fluid.velocity.read, curl: fluid.curl, dst: fluid.velocity.write }).dispatch(16, 9);
  fluid.velocity.swap();

  p.divergence.set({ velocity: fluid.velocity.read, divergence: fluid.divergence }).dispatch(16, 9);
  for (let i = 0; i < 3; i++) {
    p.pressure.set({
      params: { decay: i === 0 ? 0.8 : 1, _pad: [0, 0, 0] },
      src: fluid.pressure.read,
      divergence: fluid.divergence,
      dst: fluid.pressure.write,
    }).dispatch(16, 9);
    fluid.pressure.swap();
  }

  p.project.set({ src: fluid.velocity.read, pressure: fluid.pressure.read, dst: fluid.velocity.write }).dispatch(16, 9);
  fluid.velocity.swap();

  p.advectDye.set({ input: dynamic, src: fluid.dye.read, velocity: fluid.velocity.read, dst: fluid.dye.write }).dispatch(64, 36);
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

function inputUniforms(fluid: Fluid, input?: StirInput) {
  const time = fluid.step / 60;
  const [a, b] = idleEmitters(fluid.step);
  const sinceInput = fluid.step - fluid.lastInputStep;
  const idle = sinceInput < 90 ? 0.15 : 0.15 + 0.85 * Math.min(1, (sinceInput - 90) / 60);
  const ramp = Math.min(1, (fluid.step + 1) / 24);
  let pointerVelocity = input?.velocity ?? [0, 0] as [number, number];
  if (input?.active && Math.hypot(...pointerVelocity) < 0.02) {
    pointerVelocity = [0.16 * Math.cos(time * 5), 0.16 * Math.sin(time * 5)];
  }
  const speed = Math.hypot(...pointerVelocity);
  const direction = speed > 1e-4 ? [pointerVelocity[0] / speed, pointerVelocity[1] / speed] : [0, 0];
  return {
    step: fluid.step,
    pointer_active: input?.active ? 1 : 0,
    _pad0: [0, 0],
    pointer_from: input?.from ?? [0.5, 0.5],
    pointer_to: input?.to ?? [0.5, 0.5],
    pointer_velocity: pointerVelocity,
    _pad1: [0, 0],
    // Like the reference, splat color comes from movement direction, with blue held high.
    pointer_color: [0.5 + 0.5 * direction[0]!, 0.5 + 0.5 * direction[1]!, 1, 1],
    idle_a: [...a, ramp * idle, 0.006],
    idle_b: [...b, ramp * idle, 0.0055],
  };
}
