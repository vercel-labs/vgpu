import { init } from 'vgpu';
import computeSource from './compute.wgsl';
import renderSource from './render.wgsl';

const PARTICLE_COUNT = 24000;

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const gpu = await init(canvas, { dpr: [1, 2] });
  const positions = gpu.storage(PARTICLE_COUNT * 16, 'read-write');
  const velocities = gpu.storage(PARTICLE_COUNT * 16, 'read-write');
  const sim = gpu.compute(computeSource, { set: { positions, velocities } });
  const draw = gpu.draw({ shader: renderSource, set: { positions, velocities }, instances: PARTICLE_COUNT, vertices: 3 });
  const handle = gpu.frame.loop(() => {
    const size = gpu.screen?.size ?? [canvas.width, canvas.height];
    sim.set({ sim: { time: gpu.time, deltaTime: gpu.deltaTime, aspect: size[0] / Math.max(size[1], 1), count: PARTICLE_COUNT, mouse: [0, 0], mouseStrength: 0, pad: 0 } });
    sim.dispatch(Math.ceil(PARTICLE_COUNT / 64));
    draw.set({ renderUniforms: { resolution: size, time: gpu.time, count: PARTICLE_COUNT } });
    draw.draw();
  });
  return () => { handle.stop(); gpu.dispose(); };
}
