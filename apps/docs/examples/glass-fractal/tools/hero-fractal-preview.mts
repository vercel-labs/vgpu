#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ShaderSource } from "@vgpu/wgsl";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { PNG } from "pngjs";
import { effect, frame, init, sampler, target } from "vgpu/node";

type PreviewShape = "sphere" | "fractal";

interface PreviewOptions {
  readonly outDir: string;
  readonly shapes: readonly PreviewShape[];
  readonly size: readonly [number, number];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = resolve(HERE, "..");
const DEFAULT_OUT_DIR = join(tmpdir(), "vgpu-hero-fractal-preview");
const FRACTAL_CAMERA = {
  cameraRotation: [0, 1.40, 0],
  cameraDistance: [0, 0, 4],
  cameraTarget: [0, 0.18, 0],
  fov: 40,
} as const;
const FRACTAL_MATERIAL = {
  baseColor: [0.72, 0.68, 0.60],
  roughness: 0.68,
  diffuseStrength: 1,
  specularStrength: 0.55,
  ambientStrength: 0.22,
  lightIntensity: 4.5,
} as const;
const FLOOR_BAKE_SIZE = 512;

async function resolveHeroShader(file: string): Promise<ShaderSource> {
  const entry = resolve(EXAMPLE_DIR, file);
  const resolved = await resolveShader({
    entry,
    rootDir: EXAMPLE_DIR,
    validate: false,
  });
  return prepareShader(resolved, entry);
}

function parseArgs(argv: readonly string[]): PreviewOptions {
  let outDir = DEFAULT_OUT_DIR;
  let size: readonly [number, number] = [640, 420];
  let shapes: readonly PreviewShape[] = ["sphere", "fractal"];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--out") {
      outDir = resolve(argv[++index] ?? "");
    } else if (token === "--size") {
      const [width, height] = (argv[++index] ?? "").split("x").map(Number);
      if (!width || !height) throw new Error("--size expects WIDTHxHEIGHT");
      size = [Math.floor(width), Math.floor(height)];
    } else if (token === "--shape") {
      const value = argv[++index];
      if (value === "both") shapes = ["sphere", "fractal"];
      else if (value === "sphere" || value === "fractal") shapes = [value];
      else throw new Error("--shape expects sphere, fractal, or both");
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return { outDir, shapes, size };
}

async function writePng(
  path: string,
  size: readonly [number, number],
  pixels: Uint8Array,
): Promise<void> {
  const png = new PNG({ width: size[0], height: size[1] });
  png.data.set(pixels);
  await writeFile(path, PNG.sync.write(png));
}

const options = parseArgs(process.argv.slice(2));
await mkdir(options.outDir, { recursive: true });

const gpu = await init();
const gpuErrors: unknown[] = [];
const unsubscribe = gpu.onError((error) => gpuErrors.push(error));

try {
  for (const shape of options.shapes) {
    const output = target(gpu, {
      size: options.size,
      format: "rgba8unorm",
      label: `hero-fractal-${shape}-preview`,
    });

    try {
      if (shape === "sphere") {
        const shader = effect(
          gpu,
          await resolveHeroShader("hero-fractal-sphere-preview.wgsl"),
          { label: "hero-fractal-sphere-preview" },
        );
        shader.set({
          preview: {
            resolution: options.size,
            material: FRACTAL_MATERIAL,
          },
        });
        await shader.compile({ colors: [output.format] });
        frame(gpu, (currentFrame) => {
          currentFrame.pass(
            { target: output, clear: [1, 1, 1, 1] },
            (pass) => pass.draw(shader),
          );
        });
      } else {
        const [depthWgsl, floorBakeWgsl, compositeWgsl] = await Promise.all([
          resolveHeroShader("hero-fractal-depth.wgsl"),
          resolveHeroShader("hero-fractal-floor-bake.wgsl"),
          resolveHeroShader("hero-fractal.wgsl"),
        ]);
        const geometryTarget = target(gpu, {
          size: options.size,
          colors: [
            { format: "r32float" },
            { format: "rgba8unorm" },
          ],
          label: "hero-fractal-geometry-preview",
        });
        const floorBakeTarget = target(gpu, {
          size: [FLOOR_BAKE_SIZE, FLOOR_BAKE_SIZE],
          format: "rgba8unorm",
          label: "hero-fractal-floor-bake-preview",
        });
        const depthShader = effect(gpu, depthWgsl, {
          label: "hero-fractal-depth-preview",
        });
        const floorBakeShader = effect(gpu, floorBakeWgsl, {
          label: "hero-fractal-floor-bake-preview",
        });
        const compositeShader = effect(gpu, compositeWgsl, {
          label: "hero-fractal-composite-preview",
        });
        const floorBakeSampler = sampler(gpu, {
          minFilter: "linear",
          magFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        });
        const fovRadians = FRACTAL_CAMERA.fov * Math.PI / 180;
        const camera = {
          resolution: options.size,
          cameraRotation: FRACTAL_CAMERA.cameraRotation,
          cameraDistance: FRACTAL_CAMERA.cameraDistance,
          cameraTarget: FRACTAL_CAMERA.cameraTarget,
          tanHalfFov: Math.tan(fovRadians * 0.5),
        };
        depthShader.set({ params: camera });
        compositeShader.set({
          params: { ...camera, material: FRACTAL_MATERIAL },
          depthTexture: geometryTarget.colors[0],
          normalTexture: geometryTarget.colors[1],
          floorBakeTexture: floorBakeTarget,
          floorSampler: floorBakeSampler,
        });
        await Promise.all([
          depthShader.compile(geometryTarget),
          floorBakeShader.compile(floorBakeTarget),
          compositeShader.compile({ colors: [output.format] }),
        ]);
        frame(gpu, (currentFrame) => {
          currentFrame.pass(
            { target: floorBakeTarget, clear: [1, 1, 0, 1] },
            (pass) => pass.draw(floorBakeShader),
          );
          currentFrame.pass(
            { target: geometryTarget, clear: [0, 0, 0, 1] },
            (pass) => pass.draw(depthShader),
          );
          currentFrame.pass(
            { target: output, clear: [1, 1, 1, 1] },
            (pass) => pass.draw(compositeShader),
          );
        });
      }
      await gpu.gpu.queue.onSubmittedWorkDone();
      await gpu.settled();

      const path = join(options.outDir, `${shape}.png`);
      await writePng(
        path,
        options.size,
        await output.color.read({ mipLevel: 0, region: "all" }),
      );
      console.log(path);
    } finally {
      output.color.destroy();
    }
  }

  if (gpuErrors.length > 0) {
    throw new AggregateError(gpuErrors, "WebGPU reported preview errors");
  }
} finally {
  unsubscribe();
  gpu.dispose();
}
