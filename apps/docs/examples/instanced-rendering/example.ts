import type { Bundle, Draw, Effect, Frame, Gpu, Mesh, Surface, Target } from 'vgpu';
import { perspectiveCamera } from 'vgpu/scene';
import sceneWgsl from './scene.wgsl';
import blitWgsl from './blit.wgsl';

type Output = Surface | Target;
interface ThumbOptions { warmupFrames?: number; dt?: number; time?: number }
interface Scene { mesh: Mesh; draw: Draw; bundle: Bundle; extent: number }
const CLEAR = [0.008, 0.014, 0.035, 1] as const;

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const target = gpu.target({ size: surface.size, format: 'rgba8unorm', depth: true });
  const blit = createBlit(gpu, target, surface);
  let scene = await createScene(gpu, target, 50);
  let disposed = false;
  let sawInitialResize = false;
  const select = installCountSelect(canvas, async (n) => {
    const next = await createScene(gpu, target, n);
    if (disposed) { next.mesh.destroy(); return; }
    scene.mesh.destroy();
    scene = next;
  });
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
    select.remove();
    scene.mesh.destroy();
    (target as { destroy?: () => void }).destroy?.();
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const target = gpu.target({ size: output.size, format: 'rgba8unorm', depth: true });
  const blit = createBlit(gpu, target, output);
  const scene = await createScene(gpu, target, 50);
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

async function createScene(gpu: Gpu, target: Target, n: number): Promise<Scene> {
  const mesh = gpu.mesh({
    label: `instanced-cubes-${n}`,
    buffers: [
      { data: cubeVertices().buffer as ArrayBuffer, stride: 24, attributes: { local_position: 'float32x3', local_normal: 'float32x3' } },
      { data: makeInstances(n).buffer as ArrayBuffer, stride: 28, stepMode: 'instance', attributes: { i_position: 'float32x3', i_color: 'float32x3', i_seed: 'float32' } },
    ],
  });
  const draw = gpu.draw({ shader: sceneWgsl, mesh, label: `instanced-cubes-${n}` });
  draw.set({ light: [-0.45, -0.75, -0.35] });
  await draw.compile(target);
  const bundle = gpu.bundle({ target, label: `instanced-cubes-${n}` }, (b) => b.draw(draw));
  return { mesh, draw, bundle, extent: n * 0.64 };
}

function render(frame: Frame, scene: Scene, blit: Effect, target: Target, output: Output, time: number): void {
  const radius = scene.extent * 1.55;
  const angle = time * 0.06 + 0.55;
  const camera = perspectiveCamera({
    fov: 42, aspect: output.size[0] / Math.max(1, output.size[1]), near: 0.1, far: radius * 4,
    position: [Math.cos(angle) * radius, radius * 0.62, Math.sin(angle) * radius], target: [0, 0, 0],
  });
  scene.draw.set({ time, viewProjection: camera.viewProjection });
  frame.pass({ target, clear: CLEAR }, (p) => p.bundles(scene.bundle));
  frame.pass({ target: output }, (p) => p.draw(blit));
}

function createBlit(gpu: Gpu, source: Target, output: Output): Effect {
  const blit = gpu.effect(blitWgsl, { label: 'instanced-rendering-blit' });
  setBlitSource(blit, source, output);
  return blit;
}
function setBlitSource(blit: Effect, source: Target, output: Output): void {
  blit.set({ scene_tex: source, resolution: output.size });
}

function installCountSelect(canvas: HTMLCanvasElement, onChange: (n: number) => Promise<void>): HTMLSelectElement {
  const select = document.createElement('select');
  select.title = 'Instance count (1M is an opt-in stress test)';
  select.innerHTML = '<option value="50">50³ (125k)</option><option value="100">100³ (1M — stress test)</option>';
  select.style.cssText = 'position:absolute;top:12px;right:12px;padding:6px 9px;border:1px solid #35506f;border-radius:6px;background:#081426;color:#d8efff;font:12px system-ui;z-index:2';
  canvas.parentElement?.append(select);
  select.addEventListener('change', async () => {
    select.disabled = true;
    try { await onChange(Number(select.value)); } finally { select.disabled = false; }
  });
  return select;
}

function makeInstances(n: number): Float32Array {
  const data = new Float32Array(n * n * n * 7);
  const center = (n - 1) * 0.5;
  let o = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let h = Math.imul(x + 11, 73856093) ^ Math.imul(y + 17, 19349663) ^ Math.imul(z + 23, 83492791);
    h = (h ^ (h >>> 13)) >>> 0;
    const hue = (h % 1024) / 1024;
    const color = hue < .34 ? [.08, .7 + hue * .6, 1] : hue < .67 ? [1, .12, .68 + hue * .25] : [1, .55 + hue * .32, .08];
    data.set([(x - center) * .64, (y - center) * .64, (z - center) * .64, ...color, h / 0xffffffff], o);
    o += 7;
  }
  return data;
}

function cubeVertices(): Float32Array<ArrayBuffer> {
  const out: number[] = [];
  const faces = [
    [[1, 0, 0], [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, 0, 0], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
    [[0, 1, 0], [-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], [[0, -1, 0], [-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
    [[0, 0, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[0, 0, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
  ] as const;
  for (const [normal, a, b, c, d] of faces) for (const p of [a, b, c, a, c, d]) out.push(p[0] * .18, p[1] * .18, p[2] * .18, ...normal);
  return new Float32Array(out);
}
