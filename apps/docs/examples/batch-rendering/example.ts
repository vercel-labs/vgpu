import type { Bundle, Draw, Effect, Frame, Gpu, Mesh, Surface, Target } from 'vgpu';
import { perspectiveCamera } from 'vgpu/scene';
import sceneWgsl from './scene.wgsl';
import blitWgsl from './blit.wgsl';

type Output = Surface | Target;
interface ThumbOptions { warmupFrames?: number; dt?: number; time?: number }
interface Scene { mesh: Mesh; draws: readonly Draw[]; bundle: Bundle }
const CLEAR = [0.008, 0.014, 0.035, 1] as const;

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const target = gpu.target({ size: surface.size, format: 'rgba8unorm', depth: true });
  const blit = createBlit(gpu, target, surface);
  const scene = await createScene(gpu, target);
  let disposed = false;
  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) { sawInitialResize = true; return; }
    if (disposed) return;
    target.resize(surface.size);
    setBlitSource(blit, target, surface);
  });
  const loop = gpu.frame.loop((frame) => render(frame, scene, blit, target, surface, gpu.time));
  return () => {
    if (disposed) return;
    disposed = true;
    loop.stop();
    unsubscribeResize();
    scene.mesh.destroy();
    (target as { destroy?: () => void }).destroy?.();
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const target = gpu.target({ size: output.size, format: 'rgba8unorm', depth: true });
  const blit = createBlit(gpu, target, output);
  const scene = await createScene(gpu, target);
  await blit.compile(output);
  let time = opts.time ?? 2.4;
  for (let i = 0; i < (opts.warmupFrames ?? 3); i++) {
    time += opts.dt ?? 1 / 60;
    gpu.frame((frame) => render(frame, scene, blit, target, output, time));
  }
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  scene.mesh.destroy();
  (target as { destroy?: () => void }).destroy?.();
}

async function createScene(gpu: Gpu, target: Target): Promise<Scene> {
  const groups = packedGeometry();
  const counts = groups.map((group) => group.length / 9);
  const data = new Float32Array(groups.reduce((sum, group) => sum + group.length, 0));
  let offset = 0;
  for (const group of groups) { data.set(group, offset); offset += group.length; }
  if (counts.some((count) => count % 3) || counts.reduce((a, b) => a + b, 0) !== data.length / 9) throw new Error('Invalid packed triangle ranges.');

  const mesh = gpu.mesh({
    label: 'batch-rendering-packed-primitives',
    buffers: [{ data, stride: 36, attributes: { position: 'float32x3', normal: 'float32x3', color: 'float32x3' } }],
  });
  const slices = counts.map((vertexCount, i) => mesh.slice({
    firstVertex: counts.slice(0, i).reduce((a, b) => a + b, 0), vertexCount, label: ['cubes', 'pyramids', 'octahedra', 'icosahedra'][i],
  }));
  const draws = slices.map((slice, i) => gpu.draw({ shader: sceneWgsl, mesh: slice, label: `batch-${i}` }));
  const initial = camera(2.4, target);
  for (const draw of draws) draw.set({ light: [-0.45, -0.75, -0.35], time: 2.4, viewProjection: initial });
  await Promise.all(draws.map((draw) => draw.compile(target)));
  // Slices freeze their ranges; this bundle also captures the pyramid's equivalent call-level override.
  // A changing range would require a direct pass.draw override or re-recording the bundle.
  const bundle = gpu.bundle({ target, label: 'batch-rendering-primitives' }, (b) => {
    b.draw(draws[0]!);
    b.draw(draws[1]!, { firstVertex: slices[1]!.firstVertex, vertices: slices[1]!.vertexCount });
    b.draw(draws[2]!);
    b.draw(draws[3]!);
  });
  return { mesh, draws, bundle };
}

function render(frame: Frame, scene: Scene, blit: Effect, target: Target, output: Output, time: number): void {
  const viewProjection = camera(time, output);
  for (const draw of scene.draws) draw.set({ time, viewProjection });
  frame.pass({ target, clear: CLEAR }, (p) => p.bundles(scene.bundle));
  frame.pass({ target: output }, (p) => p.draw(blit));
}
function camera(time: number, output: Output): Float32Array {
  const angle = time * .06 + .55;
  return perspectiveCamera({
    fov: 42, aspect: output.size[0] / Math.max(1, output.size[1]), near: .1, far: 100,
    position: [Math.cos(angle) * 24.8, 15.4, Math.sin(angle) * 24.8], target: [0, 0, 0],
  }).viewProjection;
}
function createBlit(gpu: Gpu, source: Target, output: Output): Effect {
  const blit = gpu.effect(blitWgsl, { label: 'batch-rendering-blit' });
  blit.set({ linear_samp: gpu.sampler({ minFilter: 'linear', magFilter: 'linear' }) });
  setBlitSource(blit, source, output);
  return blit;
}
function setBlitSource(blit: Effect, source: Target, output: Output): void {
  blit.set({ scene_tex: source, resolution: output.size });
}

function packedGeometry(): number[][] {
  const groups = [[], [], [], []] as number[][];
  const shapes = [cube(), pyramid(), octahedron(), icosahedron()];
  const center = 7.5;
  for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const kind = (x + 2 * y + 3 * z) % 4;
    const hash = ((Math.imul(x + 3, 73856093) ^ Math.imul(y + 5, 19349663) ^ Math.imul(z + 7, 83492791)) >>> 0);
    const hue = (hash % 997) / 997;
    const color: Vec3 = hue < .34 ? [.08, .78, 1] : hue < .67 ? [1, .12, .76] : [1, .72, .08];
    append(groups[kind]!, shapes[kind]!, [(x - center), (y - center), (z - center)], color, hash / 0xffffffff);
  }
  return groups;
}

type Vec3 = readonly [number, number, number];
function append(out: number[], triangles: readonly Vec3[], center: Vec3, color: Vec3, seed: number): void {
  const angle = (seed - .5) * .7, tilt = (seed * 1.7 - .5) * .38;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = transform(triangles[i]!, angle, tilt), b = transform(triangles[i + 1]!, angle, tilt), c = transform(triangles[i + 2]!, angle, tilt);
    const normal = normalize(cross(sub(b, a), sub(c, a)));
    for (const p of [a, b, c]) out.push(p[0] + center[0], p[1] + center[1], p[2] + center[2], ...normal, ...color);
  }
}
function transform(p: Vec3, y: number, x: number): Vec3 {
  const cy = Math.cos(y), sy = Math.sin(y), cx = Math.cos(x), sx = Math.sin(x), scale = .34;
  const px = p[0] * cy + p[2] * sy, pz = -p[0] * sy + p[2] * cy;
  return [px * scale, (p[1] * cx - pz * sx) * scale, (p[1] * sx + pz * cx) * scale];
}
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(v: Vec3): Vec3 { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

function cube(): Vec3[] {
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z], out: Vec3[] = [];
  const faces = [[v(-1,-1,1),v(1,-1,1),v(1,1,1),v(-1,1,1)],[v(1,-1,-1),v(-1,-1,-1),v(-1,1,-1),v(1,1,-1)],[v(1,-1,1),v(1,-1,-1),v(1,1,-1),v(1,1,1)],[v(-1,-1,-1),v(-1,-1,1),v(-1,1,1),v(-1,1,-1)],[v(-1,1,1),v(1,1,1),v(1,1,-1),v(-1,1,-1)],[v(-1,-1,-1),v(1,-1,-1),v(1,-1,1),v(-1,-1,1)]];
  for (const [a,b,c,d] of faces) out.push(a!,b!,c!,a!,c!,d!); return out;
}
function pyramid(): Vec3[] {
  const a: Vec3=[-1,-1,-1],b: Vec3=[1,-1,-1],c: Vec3=[1,-1,1],d: Vec3=[-1,-1,1],t: Vec3=[0,1.35,0];
  return [a,d,c,a,c,b,a,b,t,b,c,t,c,d,t,d,a,t];
}
function octahedron(): Vec3[] {
  const t: Vec3=[0,1.3,0],b: Vec3=[0,-1.3,0],a: Vec3=[1,0,0],c: Vec3=[0,0,1],d: Vec3=[-1,0,0],e: Vec3=[0,0,-1];
  return [t,a,c,t,c,d,t,d,e,t,e,a,b,c,a,b,d,c,b,e,d,b,a,e];
}
function icosahedron(): Vec3[] {
  const p=(1+Math.sqrt(5))/2, v: Vec3[]=[[-1,p,0],[1,p,0],[-1,-p,0],[1,-p,0],[0,-1,p],[0,1,p],[0,-1,-p],[0,1,-p],[p,0,-1],[p,0,1],[-p,0,-1],[-p,0,1]];
  const f=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  return f.flatMap(([a,b,c]) => [v[a!]!,v[b!]!,v[c!]!]);
}
