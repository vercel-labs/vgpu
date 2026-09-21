import type { Effect, Frame, Geometry, Gpu, Surface, Target } from "vgpu";
import { bundle, draw, effect, geometry, sampler } from "vgpu";
import { perspectiveCamera } from "vgpu/scene";

import blitWgsl from "./blit.wgsl";
import sceneWgsl from "./scene.wgsl";

type Output = Surface | Target;
export type InstanceCount = 50 | 100;
export const DEFAULT_INSTANCE_COUNT: InstanceCount = 50;
export const INSTANCE_COUNT_OPTIONS = {
  "50³ (125k)": 50,
  "100³ (1M — stress test)": 100,
} as const;

const CLEAR = [0.008, 0.014, 0.035, 1] as const;

export function isInstanceCount(value: number): value is InstanceCount {
  return value === 50 || value === 100;
}

export async function createScene(
  gpu: Gpu,
  colorTarget: Target,
  n: InstanceCount
) {
  let geo: Geometry | undefined;
  try {
    geo = geometry(gpu, {
      label: `instanced-cubes-${n}`,
      buffers: [
        {
          data: cubeVertices().buffer as ArrayBuffer,
          stride: 24,
          attributes: {
            local_position: "float32x3",
            local_normal: "float32x3",
          },
        },
        {
          data: makeInstances(n).buffer as ArrayBuffer,
          stride: 28,
          stepMode: "instance",
          attributes: {
            i_position: "float32x3",
            i_color: "float32x3",
            i_seed: "float32",
          },
        },
      ],
    });
    const drawable = draw(gpu, {
      shader: sceneWgsl,
      geometry: geo,
      label: `instanced-cubes-${n}`,
    });
    drawable.set({ light: [-0.45, -0.75, -0.35] });
    await Promise.resolve().then(() => drawable.compile(colorTarget));
    const recorded = bundle(
      gpu,
      { target: colorTarget, label: `instanced-cubes-${n}` },
      (b) => b.draw(drawable)
    );
    return {
      geometry: geo,
      draw: drawable,
      bundle: recorded,
      extent: n * 0.64,
    };
  } catch (error) {
    try {
      geo?.destroy();
    } catch {
      // Cleanup must not replace allocation, compile, or bundle failure.
    }
    throw error;
  }
}

export type InstancedScene = Awaited<ReturnType<typeof createScene>>;

export function renderScene(
  currentFrame: Frame,
  scene: InstancedScene,
  blit: Effect,
  colorTarget: Target,
  output: Output,
  time: number
): void {
  const radius = scene.extent * 1.55;
  const angle = time * 0.06 + 0.55;
  const camera = perspectiveCamera({
    fov: 42,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: radius * 4,
    position: [
      Math.cos(angle) * radius,
      radius * 0.62,
      Math.sin(angle) * radius,
    ],
    target: [0, 0, 0],
  });
  scene.draw.set({ time, viewProjection: camera.viewProjection });
  currentFrame.pass({ target: colorTarget, clear: CLEAR }, (p) =>
    p.bundles(scene.bundle)
  );
  currentFrame.pass({ target: output }, (p) => p.draw(blit));
}
export function createBlit(gpu: Gpu, source: Target, output: Output): Effect {
  const blit = effect(gpu, blitWgsl, { label: "instanced-rendering-blit" });
  blit.set({
    linear_samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
    scene_tex: source,
    resolution: output.size,
  });
  return blit;
}

function makeInstances(n: InstanceCount): Float32Array {
  const data = new Float32Array(n * n * n * 7);
  const center = (n - 1) * 0.5;
  let o = 0;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let h =
          Math.imul(x + 11, 73856093) ^
          Math.imul(y + 17, 19349663) ^
          Math.imul(z + 23, 83492791);
        h = (h ^ (h >>> 13)) >>> 0;
        const hue = (h % 1024) / 1024;
        const color =
          hue < 0.34
            ? [0.08, 0.7 + hue * 0.6, 1]
            : hue < 0.67
            ? [1, 0.12, 0.68 + hue * 0.25]
            : [1, 0.55 + hue * 0.32, 0.08];
        data.set(
          [
            (x - center) * 0.64,
            (y - center) * 0.64,
            (z - center) * 0.64,
            ...color,
            h / 0xffffffff,
          ],
          o
        );
        o += 7;
      }
  return data;
}
function cubeVertices(): Float32Array<ArrayBuffer> {
  const out: number[] = [];
  // Each row is a face normal followed by its four winding-ordered corners.
  const faces = [
    [1, 0, 0, 1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1],
    [-1, 0, 0, -1, -1, 1, -1, 1, 1, -1, 1, -1, -1, -1, -1],
    [0, 1, 0, -1, 1, -1, -1, 1, 1, 1, 1, 1, 1, 1, -1],
    [0, -1, 0, -1, -1, 1, -1, -1, -1, 1, -1, -1, 1, -1, 1],
    [0, 0, 1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    [0, 0, -1, 1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1, -1],
  ] as const;
  for (const face of faces)
    for (const i of [3, 6, 9, 3, 9, 12])
      out.push(
        face[i]! * 0.18,
        face[i + 1]! * 0.18,
        face[i + 2]! * 0.18,
        face[0],
        face[1],
        face[2]
      );
  return new Float32Array(out);
}
