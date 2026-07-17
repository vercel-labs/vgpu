import { init, type Gpu, type Target } from 'vgpu';
import computeSource from './compute.wgsl';
import renderSource from './render.wgsl';

const PARTICLE_COUNT = 24000;
const WORKGROUP_SIZE = 64;

export interface TriangleParticlesThumbOptions {
  readonly frames: number;
  readonly dt: number;
}

function createTriangleParticles(gpu: Gpu) {
  // TODO(vgpu): pre-warm pipelines with compile() once compile()/compileSync lands.
  const positions = gpu.storage(PARTICLE_COUNT * 16, 'read-write');
  const velocities = gpu.storage(PARTICLE_COUNT * 16, 'read-write');
  initializeParticles(positions, velocities);
  const sim = gpu.compute(computeSource, { set: { positions, velocities } });
  const draw = gpu.draw({ shader: renderSource, set: { positions, velocities }, instances: PARTICLE_COUNT, vertices: 3 });
  return { sim, draw };
}

function initializeParticles(
  positions: ReturnType<Gpu['storage']>,
  velocities: ReturnType<Gpu['storage']>,
): void {
  const positionData = new Float32Array(PARTICLE_COUNT * 4);
  const velocityData = new Float32Array(PARTICLE_COUNT * 4);
  const vertices = [
    [0, 1.28],
    [-1.1, -0.64],
    [1.1, -0.64],
  ] as const;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    let a = random01(i * 4 + 1);
    let b = random01(i * 4 + 2);
    if (a + b > 1) {
      a = 1 - a;
      b = 1 - b;
    }
    const c = 1 - a - b;
    const ox = vertices[0][0] * a + vertices[1][0] * b + vertices[2][0] * c;
    const oy = vertices[0][1] * a + vertices[1][1] * b + vertices[2][1] * c;
    const angle = random01(i * 4 + 3) * Math.PI * 2;
    const speed = 0.08 + random01(i * 4 + 4) * 0.22;
    const offset = i * 4;
    positionData[offset] = ox;
    positionData[offset + 1] = oy;
    positionData[offset + 2] = ox;
    positionData[offset + 3] = oy;
    velocityData[offset] = Math.cos(angle) * speed;
    velocityData[offset + 1] = Math.sin(angle) * speed;
    velocityData[offset + 2] = 0.6 + random01(i * 4 + 5) * 4.8;
    velocityData[offset + 3] = random01(i * 4 + 6) * 10000;
  }

  positions.write(positionData);
  velocities.write(velocityData);
}

function random01(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function stepTriangleParticles(scene: ReturnType<typeof createTriangleParticles>, size: readonly [number, number], time: number, deltaTime: number): void {
  scene.sim.set({
    sim: {
      time,
      deltaTime,
      aspect: size[0] / Math.max(size[1], 1),
      count: PARTICLE_COUNT,
      mouse: [0, 0],
      mouseStrength: 0,
      pad: 0,
    },
  });
  scene.sim.dispatch(Math.ceil(PARTICLE_COUNT / WORKGROUP_SIZE));
}

function drawTriangleParticles(gpu: Gpu, scene: ReturnType<typeof createTriangleParticles>, target: Target, time: number): void {
  scene.draw.set({ renderUniforms: { resolution: target.size, time, count: PARTICLE_COUNT } });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(scene.draw)));
}

export function renderThumb(gpu: Gpu, target: Target, { frames, dt }: TriangleParticlesThumbOptions): void {
  const scene = createTriangleParticles(gpu);
  let time = 0;
  for (let frame = 0; frame < frames; frame++) {
    time += dt;
    stepTriangleParticles(scene, target.size, time, dt);
  }
  drawTriangleParticles(gpu, scene, target, time);
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const scene = createTriangleParticles(gpu);
  const handle = gpu.frame.loop((frame) => {
    const size = surface.size;
    stepTriangleParticles(scene, size, gpu.time, gpu.deltaTime);
    scene.draw.set({ renderUniforms: { resolution: size, time: gpu.time, count: PARTICLE_COUNT } });
    frame.pass({ target: surface }, (p) => p.draw(scene.draw));
  });
  return () => { handle.stop(); gpu.dispose(); };
}
