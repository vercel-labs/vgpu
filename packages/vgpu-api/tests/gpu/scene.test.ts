import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { init } from "../../src/node.ts";
import { drawReflection } from "../../src/draw.ts";
import { box, orbit, perspectiveCamera } from "../../src/scene.ts";

const shaderPath = join(dirname(fileURLToPath(import.meta.url)), "scene-lit-cube.wgsl");

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("vgpu/scene Docker GPU acceptance", () => {
  test("lit cube resolves std light imports and Lambert responds to light direction", async () => {
    const entry = await litCubeFixture();
    const gpu = await init();
    try {
      const shader = await resolveShader({ entry });
      expect(shader.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/light/index.wgsl"))).toBe(true);

      const mesh = gpu.mesh(box({ size: 1 }));
      const lit = await renderCube(gpu, shader.wgsl, mesh, [-1, 1, -1]);
      const inverted = await renderCube(gpu, shader.wgsl, mesh, [1, -1, 1]);

      const litBrightFace = averageLuma(lit, 48, { x: 24, y: 24, width: 10, height: 10 });
      const litShadowFace = averageLuma(lit, 48, { x: 20, y: 9, width: 8, height: 8 });
      const invertedSameFace = averageLuma(inverted, 48, { x: 24, y: 24, width: 10, height: 10 });
      const invertedTopFace = averageLuma(inverted, 48, { x: 20, y: 9, width: 8, height: 8 });

      expect(litBrightFace).toBeGreaterThan(litShadowFace + 35);
      expect(invertedTopFace).toBeGreaterThan(invertedSameFace + 35);
      expect(litBrightFace).toBeGreaterThan(invertedSameFace + 35);
    } finally {
      gpu.dispose();
    }
  });
});

async function renderCube(gpu: Awaited<ReturnType<typeof init>>, shader: string, mesh: ReturnType<Awaited<ReturnType<typeof init>>["mesh"]>, direction: readonly [number, number, number]): Promise<Uint8Array> {
  const target = gpu.target({ size: [48, 48], format: "rgba8unorm", depth: true, label: "litCube" });
  const cube = gpu.draw({ shader, mesh, targets: [target] });
  const cam = perspectiveCamera({ fov: 45, aspect: 1, position: [2, 2, 3], target: [0, 0, 0] });

  const camera = bindingName(cube, 0);
  const model = bindingName(cube, 1);
  const light = bindingName(cube, 2);
  cube.set({
    [camera]: { viewProjection: cam.viewProjection },
    [model]: { matrix: orbit(0, { radius: 0 }) },
    [light]: { direction, color: [1, 1, 1], intensity: 1 },
  });
  cube.draw({ target });
  return target.read();
}

function bindingName(draw: Parameters<typeof drawReflection>[0], binding: number): string {
  const name = drawReflection(draw).bindings.find((item) => item.group === 0 && item.binding === binding)?.name;
  if (!name) throw new Error(`Missing reflected binding ${binding}`);
  return name;
}

function averageLuma(pixels: Uint8Array, width: number, rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): number {
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const offset = 4 * (y * width + x);
      total += pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!;
    }
  }
  return total / (rect.width * rect.height);
}

async function litCubeFixture(): Promise<string> {
  const dir = await mkdirTemp();
  await mkdir(join(dir, "app"), { recursive: true });
  await mkdir(join(dir, "node_modules", "@vgpu"), { recursive: true });
  await symlink(resolve("packages/wgsl-std"), join(dir, "node_modules", "@vgpu", "wgsl-std"), "dir");
  const entry = join(dir, "app", "scene-lit-cube.wgsl");
  await writeFile(entry, await readFile(shaderPath, "utf8"));
  return entry;
}

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "vgpu-scene-"));
}
