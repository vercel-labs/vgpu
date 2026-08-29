import {
  draw,
  effect,
  frame,
  geometry,
  sampler,
  target,
  type Frame,
  type Gpu,
  type Target,
} from "vgpu";
import type { Texture } from "vgpu/core";
import { box } from "vgpu/scene";

import blurWgsl from "./blur.wgsl";
import metalWgsl from "./metal.wgsl";
import presentWgsl from "./present.wgsl";
import { spinMatrix, type CameraView } from "./camera";
import skyWgsl from "./sky.wgsl";

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
const ENV_SIZE: readonly [number, number] = [2048, 1024];
const TEXEL_ANGLE = (2 * Math.PI) / ENV_SIZE[0];

const SKY = {
  sun_direction: [-0.724, 0.09, -0.684],
  sun_angular_size: 0.018,
  sun_color: [1.0, 0.88, 0.72],
  sun_intensity: 26,
  zenith_color: [0.05, 0.15, 0.44],
  cloud_coverage: 0.56,
  horizon_color: [0.36, 0.48, 0.74],
  cloud_scale: 0.75,
  ground_color: [0.05, 0.05, 0.056],
  ground_scale: 4.6,
} as const;

const METAL = {
  base_color: [0.56, 0.57, 0.58],
  roughness: 0,
  texel_angle: TEXEL_ANGLE,
  env_size: ENV_SIZE,
} as const;

export async function createScene(gpu: Gpu, output: Target) {
  const owned = new Set<unknown>();
  try {
    const hdr = own(owned, createHdr(gpu, output.size));
    const envSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
    });
    const sceneSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
    });
    const env = own(owned, await bakeEnvironment(gpu, envSampler));
    const cubeGeometry = own(owned, geometry(gpu, box({ size: 1.25 })));

    const cube = draw(gpu, { shader: metalWgsl, geometry: cubeGeometry });
    cube.set({ ...METAL, env_tex: env, env_samp: envSampler });
    const present = effect(gpu, presentWgsl);
    present.set({
      env_tex: env,
      env_samp: envSampler,
      scene_tex: hdr,
      scene_samp: sceneSampler,
    });
    await compileAll([
      () => cube.compile(hdr),
      () => present.compile({ colors: [output.format] }),
    ]);
    return { env, hdr, geometry: cubeGeometry, cube, present };
  } catch (error) {
    runCleanups(cleanupOwned(owned), { error });
  }
}

export type Scene = Awaited<ReturnType<typeof createScene>>;

async function bakeEnvironment(
  gpu: Gpu,
  samplerState: GPUSampler
): Promise<Texture> {
  const owned = new Set<unknown>();
  const makeTarget = (size: readonly [number, number]) =>
    own(owned, target(gpu, { size, format: HDR_FORMAT }));

  try {
    const env = own(
      owned,
      gpu.device.createTexture({
        size: [...ENV_SIZE],
        format: HDR_FORMAT,
        mipLevelCount: 8,
        usage: ["texture_binding", "copy_dst"],
      })
    );
    const sky = effect(gpu, skyWgsl);
    sky.set({ sky: SKY });
    const blur = effect(gpu, blurWgsl);
    const blurPass = (
      source: Target,
      output: Target,
      direction: readonly [number, number],
      equirectCompensation: number
    ) => {
      blur.set({
        src: source,
        src_samp: samplerState,
        blur: {
          texel: [1 / output.size[0], 1 / output.size[1]],
          direction,
          radius: 1.15,
          equirect_compensation: equirectCompensation,
        },
      });
      frame(gpu, (currentFrame) =>
        currentFrame.pass({ target: output }, (pass) => pass.draw(blur))
      );
    };
    let source = makeTarget(ENV_SIZE);

    await compileAll([() => sky.compile(source), () => blur.compile(source)]);
    frame(gpu, (currentFrame) =>
      currentFrame.pass({ target: source }, (pass) => pass.draw(sky))
    );
    copyIntoLevel(gpu, source, env, 0);

    for (let level = 1; level < 8; level++) {
      const size: [number, number] = [
        ENV_SIZE[0] >> level,
        ENV_SIZE[1] >> level,
      ];
      const horizontal = makeTarget(size);
      const vertical = makeTarget(size);
      blurPass(source, horizontal, [1, 0], 1);
      blurPass(horizontal, vertical, [0, 1], 0);
      copyIntoLevel(gpu, vertical, env, level);
      runCleanups([
        () => release(owned, horizontal),
        () => release(owned, source),
      ]);
      source = vertical;
    }
    release(owned, source);
    owned.delete(env);
    return env;
  } catch (error) {
    runCleanups(cleanupOwned(owned), { error });
  }
}

function copyIntoLevel(
  gpu: Gpu,
  source: Target,
  env: Texture,
  level: number
): void {
  const encoder = gpu.gpu.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture: source.color.gpu },
    { texture: env.gpu, mipLevel: level },
    [source.size[0], source.size[1], 1]
  );
  gpu.gpu.queue.submit([encoder.finish()]);
}

export function render(
  currentFrame: Frame,
  scene: Scene,
  output: Target,
  view: CameraView,
  time: number
): void {
  scene.cube.set({
    view_projection: view.camera.viewProjection,
    model: spinMatrix(time),
    camera_position: view.position,
  });
  scene.present.set({
    camera: {
      position: view.position,
      tan_half_fov: view.tanHalfFov,
      forward: view.forward,
      aspect: view.aspect,
      right: view.right,
      exposure: 0.9,
      up: view.up,
      background_intensity: 1,
      texel_angle: TEXEL_ANGLE,
      env_size: ENV_SIZE,
    },
  });

  currentFrame.pass({ target: scene.hdr, clear: [0, 0, 0, 0] }, (pass) =>
    pass.draw(scene.cube)
  );
  currentFrame.pass({ target: output }, (pass) => pass.draw(scene.present));
}

export function aspectOf(output: Target): number {
  return output.size[0] / Math.max(1, output.size[1]);
}

export function replaceHdr(
  gpu: Gpu,
  scene: Scene,
  size: readonly [number, number]
): void {
  const previous = scene.hdr;
  const next = createHdr(gpu, size);
  try {
    scene.present.set({ scene_tex: next });
  } catch (error) {
    runCleanups(
      [
        () => scene.present.set({ scene_tex: previous }),
        () => destroyOwned(next),
      ],
      { error }
    );
  }
  scene.hdr = next;
  destroyOwned(previous);
}

export function destroyScene(scene: Scene): void {
  runCleanups([
    () => scene.geometry.destroy(),
    () => destroyOwned(scene.hdr),
    () => scene.env.destroy(),
  ]);
}

function createHdr(gpu: Gpu, size: readonly [number, number]): Target {
  return target(gpu, { size, format: HDR_FORMAT, depth: true });
}

function own<T>(owned: Set<unknown>, value: T): T {
  owned.add(value);
  return value;
}

function release(owned: Set<unknown>, value: unknown): void {
  owned.delete(value);
  destroyOwned(value);
}

function cleanupOwned(owned: Set<unknown>): (() => void)[] {
  return [...owned].reverse().map((value) => () => release(owned, value));
}

function destroyOwned(value: unknown): void {
  (value as { destroy?: () => void }).destroy?.();
}

async function compileAll(attempts: readonly (() => Promise<unknown>)[]) {
  const results = await Promise.allSettled(
    attempts.map((attempt) => Promise.resolve().then(attempt))
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

export function runCleanups(
  cleanups: readonly (() => void)[],
  primary: { error: unknown }
): never;
export function runCleanups(cleanups: readonly (() => void)[]): void;
export function runCleanups(
  cleanups: readonly (() => void)[],
  primary?: { error: unknown }
): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (primary) throw primary.error;
  if (errors.length) throw errors[0];
}
