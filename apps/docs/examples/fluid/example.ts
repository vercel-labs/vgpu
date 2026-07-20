import type { Bundle, Gpu, Surface, Target } from 'vgpu';
import { installStirInput, type StirInput } from './controls';
import advectVelocityWgsl from './advect-velocity.wgsl';
import divergenceWgsl from './divergence.wgsl';
import pressureWgsl from './pressure.wgsl';
import projectWgsl from './project.wgsl';
import advectDyeWgsl from './advect-dye.wgsl';
import updateParticlesWgsl from './update-particles.wgsl';
import displayWgsl from './display.wgsl';
import particlesWgsl from './particles.wgsl';

const WIDTH = 128;
const HEIGHT = 72;
const CELLS = WIDTH * HEIGHT;
const TRACERS = 8192;
const STEP = 1 / 60;
const CLEAR = [0.003, 0.005, 0.014, 1] as const;

type Output = Surface | Target;
type StoragePair = ReturnType<Gpu['pingPongStorage']>;

interface FluidState {
  readonly gpu: Gpu;
  readonly velocity: StoragePair;
  readonly dye: StoragePair;
  readonly pressure: StoragePair;
  readonly divergence: ReturnType<Gpu['storage']>;
  readonly tracer: ReturnType<Gpu['device']['createBuffer']>;
  readonly mesh: ReturnType<Gpu['mesh']>;
  readonly passes: ReturnType<typeof createPasses>;
  step: number;
  lastInputStep: number;
  bundles: [Bundle, Bundle] | undefined;
  bundleOutput: Output | undefined;
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const state = createState(gpu);
  const input = installStirInput(canvas);
  await prepareRenderer(state, surface);
  let disposed = false;
  let raf = 0;
  let accumulator = 0;
  let previous = performance.now();

  const tick = (now: number) => {
    if (disposed) return;
    if (!document.hidden) {
      accumulator += Math.min((now - previous) / 1000, 1 / 30);
      let count = 0;
      while (accumulator >= STEP && count < 2) { simulate(state, input); accumulator -= STEP; count++; }
      if (count === 2) accumulator = 0;
      render(state, surface);
    }
    previous = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    input.dispose();
    state.mesh.destroy();
    state.tracer.destroy();
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(gpu: Gpu, target: Target, opts: { warmupFrames?: number } = {}): Promise<void> {
  const state = createState(gpu);
  await prepareRenderer(state, target);
  const steps = Math.max(0, opts.warmupFrames ?? 120);
  for (let i = 0; i < steps; i++) simulate(state);
  render(state, target);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  state.mesh.destroy();
  state.tracer.destroy();
}

function createState(gpu: Gpu): FluidState {
  const velocity = gpu.pingPongStorage(CELLS * 8);
  const dye = gpu.pingPongStorage(CELLS * 16);
  const pressure = gpu.pingPongStorage(CELLS * 4);
  const divergence = gpu.storage(CELLS * 4, 'read-write');
  const tracer = gpu.device.createBuffer({ size: TRACERS * 32, usage: ['vertex', 'storage', 'copy_dst'], label: 'fluid-tracer-records' });
  tracer.write(initialTracers());
  const mesh = gpu.mesh({
    label: 'fluid-passive-tracers',
    instanceCount: TRACERS,
    buffers: [
      { data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), stride: 8, attributes: { local: 'float32x2' } },
      { buffer: tracer.gpu, stride: 32, stepMode: 'instance', attributes: { particle_position: 'float32x2', particle_color: 'float32x4', particle_radius: 'float32', particle_age: 'float32' } },
    ],
  });
  return { gpu, velocity, dye, pressure, divergence, tracer, mesh, passes: createPasses(gpu, mesh), step: 0, lastInputStep: -1000, bundles: undefined, bundleOutput: undefined };
}

function createPasses(gpu: Gpu, mesh: ReturnType<Gpu['mesh']>) {
  const advectVelocity = gpu.compute(advectVelocityWgsl, { label: 'fluid-advect-velocity' });
  const divergence = gpu.compute(divergenceWgsl, { label: 'fluid-divergence' });
  const pressure = gpu.compute(pressureWgsl, { label: 'fluid-pressure-jacobi' });
  const project = gpu.compute(projectWgsl, { label: 'fluid-project' });
  const advectDye = gpu.compute(advectDyeWgsl, { label: 'fluid-advect-dye' });
  const particles = gpu.compute(updateParticlesWgsl, { label: 'fluid-update-tracers' });
  const display = [gpu.effect(displayWgsl, { label: 'fluid-display-even' }), gpu.effect(displayWgsl, { label: 'fluid-display-odd' })] as const;
  const tracers = gpu.draw({ shader: particlesWgsl, label: 'fluid-tracers', mesh, blend: { color: { src: 'one', dst: 'one' }, alpha: { src: 'one', dst: 'one' } } });
  return { advectVelocity, divergence, pressure, project, advectDye, particles, display, tracers };
}

async function prepareRenderer(state: FluidState, output: Output): Promise<void> {
  const base = { ...simUniforms(state, undefined), output_size: output.size };
  state.passes.display[0].set({ sim: base, dye: state.dye.read });
  state.passes.display[1].set({ sim: base, dye: state.dye.write });
  state.passes.tracers.set({ config: { aspect: output.size[0] / Math.max(1, output.size[1]), _pad: [0, 0, 0] } });
  await Promise.all([state.passes.display[0].compile(output), state.passes.display[1].compile(output), state.passes.tracers.compile(output)]);
  state.bundles = [0, 1].map((parity) => state.gpu.bundle({ target: output, label: `fluid-${parity ? 'odd' : 'even'}-bundle` }, (bundle) => { bundle.draw(state.passes.display[parity]!); bundle.draw(state.passes.tracers); })) as [Bundle, Bundle];
  state.bundleOutput = output;
}

function simulate(state: FluidState, input?: StirInput): void {
  if (input?.active) state.lastInputStep = state.step;
  const sim = simUniforms(state, input);
  const p = state.passes;
  p.advectVelocity.set({ sim, src: state.velocity.read, dst: state.velocity.write }).dispatch(16, 9);
  state.velocity.swap();
  p.divergence.set({ sim, velocity: state.velocity.read, divergence: state.divergence }).dispatch(16, 9);
  for (let i = 0; i < 8; i++) { p.pressure.set({ sim, src: state.pressure.read, divergence: state.divergence, dst: state.pressure.write }).dispatch(16, 9); state.pressure.swap(); }
  p.project.set({ sim, src: state.velocity.read, pressure: state.pressure.read, dst: state.velocity.write }).dispatch(16, 9);
  state.velocity.swap();
  p.advectDye.set({ sim, src: state.dye.read, velocity: state.velocity.read, dst: state.dye.write }).dispatch(16, 9);
  state.dye.swap();
  p.particles.set({ sim, velocity: state.velocity.read, dye: state.dye.read, particles: state.tracer }).dispatch(64);
  state.step++;
  input?.consumeStep();
}

function render(state: FluidState, output: Output): void {
  if (!state.bundles || state.bundleOutput !== output) return;
  state.gpu.frame((frame) => frame.pass({ target: output, clear: CLEAR }, (pass) => pass.bundles(state.bundles![state.step & 1])));
}

function simUniforms(state: FluidState, input?: StirInput) {
  const t = state.step / 60;
  const ramp = Math.min(1, (state.step + 1) / 24);
  const since = state.step - state.lastInputStep;
  const idle = since < 90 ? .15 : .15 + .85 * Math.min(1, (since - 90) / 60);
  const a: [number, number] = [.5 + .28 * Math.sin(.73 * t), .5 + .22 * Math.sin(1.09 * t + .4)];
  const b: [number, number] = [.5 + .26 * Math.sin(.61 * t + Math.PI), .5 + .24 * Math.sin(.97 * t + 2.1)];
  let velocity: [number, number] = input?.velocity ?? [0, 0];
  if (input?.active && Math.hypot(...velocity) < .02) velocity = [.16 * Math.cos(t * 5), .16 * Math.sin(t * 5)];
  const colors = [[.05, .55, 1, 1], [.65, .15, 1, 1], [1, .22, .12, 1]] as const;
  return { size: [WIDTH, HEIGHT], step: state.step, pointer_active: input?.active ? 1 : 0, pointer_from: input?.from ?? [.5, .5], pointer_to: input?.to ?? [.5, .5], pointer_velocity: velocity, pointer_color: colors[((Math.floor(state.step / 90) + (input?.stroke ?? 0)) % colors.length)]!, idle_a: [...a, ramp * idle, .085], idle_b: [...b, ramp * idle, .08], output_size: [1, 1], _pad: [0, 0] };
}

function initialTracers(): Float32Array {
  const data = new Float32Array(TRACERS * 8);
  for (let i = 0; i < TRACERS; i++) {
    const a = hash(i * 3 + 1) * Math.PI * 2; const r = Math.sqrt(hash(i * 3 + 2)) * .28;
    const k = i * 8; data[k] = .5 + Math.cos(a) * r; data[k + 1] = .5 + Math.sin(a) * r;
    data[k + 2] = .08; data[k + 3] = .2; data[k + 4] = .4; data[k + 5] = .18; data[k + 6] = .0025; data[k + 7] = hash(i * 3 + 3) * 5;
  }
  return data;
}
function hash(value: number): number { let x = value | 0; x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
