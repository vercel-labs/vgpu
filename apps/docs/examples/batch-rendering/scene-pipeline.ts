import type { Effect, Frame, Gpu, Surface, Target } from "vgpu";
import { bundle, draw, effect, geometry, sampler } from "vgpu";
import { perspectiveCamera } from "vgpu/scene";

import blitWgsl from "./blit.wgsl";
import sceneWgsl from "./scene.wgsl";

type Output = Surface | Target;
type Vec3 = readonly [number, number, number];
const CLEAR = [0.008, 0.014, 0.035, 1] as const;
const LABELS = ["cubes", "pyramids", "octahedra", "icosahedra"] as const;

export async function createScene(gpu: Gpu, colorTarget: Target) {
  const groups = packedGeometry();
  const geo = geometry(gpu, {
    label: "batch-rendering-packed-primitives",
    buffers: [
      {
        data: pack(groups),
        stride: 36,
        attributes: {
          position: "float32x3",
          normal: "float32x3",
          color: "float32x3",
        },
      },
    ],
  });
  try {
    let firstVertex = 0;
    const slices = groups.map((group, index) => {
      const vertexCount = group.length / 9;
      const slice = geo.slice({
        firstVertex,
        vertexCount,
        label: LABELS[index],
      });
      firstVertex += vertexCount;
      return slice;
    });
    const draws = slices.map((slice, i) =>
      draw(gpu, { shader: sceneWgsl, geometry: slice, label: `batch-${i}` })
    );
    const initial = camera(2.4, colorTarget);
    for (const drawable of draws)
      drawable.set({ light: [-0.45, -0.75, -0.35], viewProjection: initial });
    const compiled = await Promise.allSettled(
      draws.map((drawable) =>
        Promise.resolve().then(() => drawable.compile(colorTarget))
      )
    );
    const failure = compiled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    const recorded = bundle(
      gpu,
      { target: colorTarget, label: "batch-rendering-primitives" },
      (b) => {
        for (const drawable of draws) b.draw(drawable);
      }
    );
    return { geometry: geo, draws, bundle: recorded };
  } catch (error) {
    try {
      geo.destroy();
    } catch {
      // Cleanup must not replace the allocation, compile, or bundle failure.
    }
    throw error;
  }
}

export type BatchScene = Awaited<ReturnType<typeof createScene>>;

export function renderScene(
  currentFrame: Frame,
  scene: BatchScene,
  blit: Effect,
  colorTarget: Target,
  output: Output,
  time: number
): void {
  const viewProjection = camera(time, output);
  for (const drawable of scene.draws) drawable.set({ viewProjection });
  currentFrame.pass({ target: colorTarget, clear: CLEAR }, (p) =>
    p.bundles(scene.bundle)
  );
  currentFrame.pass({ target: output }, (p) => p.draw(blit));
}
function camera(time: number, output: Output): Float32Array {
  const angle = time * 0.06 + 0.55;
  return perspectiveCamera({
    fov: 42,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: 100,
    position: [Math.cos(angle) * 24.8, 15.4, Math.sin(angle) * 24.8],
    target: [0, 0, 0],
  }).viewProjection;
}
export function createBlit(gpu: Gpu, source: Target, output: Output): Effect {
  const blit = effect(gpu, blitWgsl, { label: "batch-rendering-blit" });
  blit.set({
    linear_samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
    scene_tex: source,
    resolution: output.size,
  });
  return blit;
}

function pack(groups: readonly number[][]) {
  const data = new Float32Array(
    groups.reduce((length, group) => length + group.length, 0)
  );
  let offset = 0;
  for (const group of groups) {
    data.set(group, offset);
    offset += group.length;
  }
  return data;
}

function packedGeometry(): number[][] {
  const groups = [[], [], [], []] as number[][];
  const shapes = [cube(), pyramid(), octahedron(), icosahedron()];
  const center = 7.5;
  for (let z = 0; z < 16; z++)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const kind = (x + 2 * y + 3 * z) % 4;
        const hash =
          (Math.imul(x + 3, 73856093) ^
            Math.imul(y + 5, 19349663) ^
            Math.imul(z + 7, 83492791)) >>>
          0;
        const hue = (hash % 997) / 997;
        const color: Vec3 =
          hue < 0.34
            ? [0.08, 0.78, 1]
            : hue < 0.67
            ? [1, 0.12, 0.76]
            : [1, 0.72, 0.08];
        append(
          groups[kind]!,
          shapes[kind]!,
          [x - center, y - center, z - center],
          color,
          hash / 0xffffffff
        );
      }
  return groups;
}
function append(
  out: number[],
  triangles: readonly Vec3[],
  center: Vec3,
  color: Vec3,
  seed: number
): void {
  const angle = (seed - 0.5) * 0.7,
    tilt = (seed * 1.7 - 0.5) * 0.38;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = transform(triangles[i]!, angle, tilt),
      b = transform(triangles[i + 1]!, angle, tilt),
      c = transform(triangles[i + 2]!, angle, tilt);
    const normal = normalize(cross(sub(b, a), sub(c, a)));
    for (const p of [a, b, c])
      out.push(
        p[0] + center[0],
        p[1] + center[1],
        p[2] + center[2],
        ...normal,
        ...color
      );
  }
}
function transform(p: Vec3, y: number, x: number): Vec3 {
  const cy = Math.cos(y),
    sy = Math.sin(y),
    cx = Math.cos(x),
    sx = Math.sin(x),
    scale = 0.34;
  const px = p[0] * cy + p[2] * sy,
    pz = -p[0] * sy + p[2] * cy;
  return [
    px * scale,
    (p[1] * cx - pz * sx) * scale,
    (p[1] * sx + pz * cx) * scale,
  ];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cube(): Vec3[] {
  return indexedShape(
    [
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1,
      -1, 1, 1,
    ],
    [
      4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2, 5, 1, 2, 5, 2, 6, 0, 4, 7, 0, 7, 3, 7,
      6, 2, 7, 2, 3, 0, 1, 5, 0, 5, 4,
    ]
  );
}
function pyramid(): Vec3[] {
  return indexedShape(
    [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, 0, 1.35, 0],
    [0, 3, 2, 0, 2, 1, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]
  );
}
function octahedron(): Vec3[] {
  return indexedShape(
    [0, 1.3, 0, 0, -1.3, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1],
    [0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2, 1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5]
  );
}
function icosahedron(): Vec3[] {
  const p = (1 + Math.sqrt(5)) / 2;
  const vertices: Vec3[] = [
    [-1, p, 0],
    [1, p, 0],
    [-1, -p, 0],
    [1, -p, 0],
    [0, -1, p],
    [0, 1, p],
    [0, -1, -p],
    [0, 1, -p],
    [p, 0, -1],
    [p, 0, 1],
    [-p, 0, -1],
    [-p, 0, 1],
  ];
  const faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10,
    2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5,
    2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  return faces.map((index) => vertices[index]!);
}
function indexedShape(
  vertices: readonly number[],
  indices: readonly number[]
): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    points.push([vertices[i]!, vertices[i + 1]!, vertices[i + 2]!]);
  }
  return indices.map((index) => points[index]!);
}
