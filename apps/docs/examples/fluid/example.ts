import { init, type Gpu, type Target } from 'vgpu';
import computeSource from './compute.wgsl';
import displaySource from './display.wgsl';

const GRID = [1280, 720] as const;
const WORKGROUP_SIZE = 8;

export interface FluidThumbOptions {
  readonly frames: number;
  readonly dt: number;
}

function createFluid(gpu: Gpu) {
  // TODO(vgpu): pre-warm compute + display pipelines with compile() once compile()/compileSync lands.
  const dye = gpu.storage(GRID[0] * GRID[1] * 16, 'read-write');
  const sim = gpu.compute(computeSource, { set: { dye } });
  const display = gpu.effect(displaySource);
  display.set({ dye });
  return { sim, display };
}

function stepFluid(scene: ReturnType<typeof createFluid>, time: number, frame: number): void {
  scene.sim.set({
    sim: {
      resolution: GRID,
      time,
      frame,
    },
  });
  scene.sim.dispatch(Math.ceil(GRID[0] / WORKGROUP_SIZE), Math.ceil(GRID[1] / WORKGROUP_SIZE));
}

function setDisplayTarget(scene: ReturnType<typeof createFluid>, target: Target): void {
  scene.display.set({ uniforms: { resolution: target.size, grid: GRID } });
}

export function renderThumb(gpu: Gpu, target: Target, { frames, dt }: FluidThumbOptions): void {
  const scene = createFluid(gpu);
  let time = 0;
  for (let frame = 0; frame < frames; frame++) {
    time += dt;
    stepFluid(scene, time, frame);
  }
  setDisplayTarget(scene, target);
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(scene.display)));
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const gpu = await init({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const scene = createFluid(gpu);
  const handle = gpu.frame.loop((frame) => {
    stepFluid(scene, gpu.time, gpu.frameCount);
    setDisplayTarget(scene, surface);
    frame.pass({ target: surface }, (p) => p.draw(scene.display));
  });
  return () => { handle.stop(); gpu.dispose(); };
}
