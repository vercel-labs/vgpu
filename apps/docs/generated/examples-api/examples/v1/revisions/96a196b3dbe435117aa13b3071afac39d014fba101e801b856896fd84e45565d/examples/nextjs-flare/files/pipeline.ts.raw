import {
  effect,
  frame,
  sampler,
  target,
  type Effect,
  type Gpu,
  type Target,
} from "vgpu";

import blurWgsl from "./blur.wgsl";
import { BLUE_NOISE_SIZE, blueNoiseBytes } from "./blue-noise-128";
import compositeWgsl from "./composite.wgsl";
import logoWgsl from "./logo.wgsl";
import rimWgsl from "./rim.wgsl";

export type Point = readonly [number, number];

export interface FlarePlacement {
  readonly logoCenter: Point;
  readonly logoScale: Point;
  readonly canvasToLogo: Point;
}

export interface LogoRaster {
  readonly width: number;
  readonly height: number;
  upload(gpu: Gpu, texture: GPUTexture): void;
}

interface FlareTargets {
  readonly scene: Target;
  readonly rim: Target;
  readonly rimA: Target;
  readonly rimB: Target;
}

interface FrameEffects {
  readonly logo: Effect;
  readonly rim: Effect;
  readonly rimBlurH: Effect;
  readonly rimBlurV: Effect;
  readonly composite: Effect;
}

interface BoundLogo extends LogoRaster {
  readonly texture: GPUTexture;
  readonly placement: FlarePlacement;
}

const TOP_LEFT_FULLSCREEN_VERTEX = /* wgsl */ `
struct FlareFullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn flare_fullscreen_vs(@builtin(vertex_index) vertexIndex: u32) -> FlareFullscreenVertexOut {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var output: FlareFullscreenVertexOut;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}
`;

const GLYPH_CENTER_IN_BOX: Point = [(48 + 466 / 2) / 514, (88 + 536 / 2) / 624];
const LOGO_HEIGHT_RATIO = 0.62;
const MAX_RENDER_WIDTH = 1920;
const PULSE_TRANSITION_SECONDS = 2;
const PULSE_FLOOR = 0.2;
const FLARE_COLOR = [179 / 255, 191 / 255, 1] as const;
const BLUR_CENTER_WEIGHT = 0.0799404796215474;
const BLUR_TAPS = [
  [1.48500449838059, 0.15215191554518462, 0, 0],
  [3.4650570548417856, 0.12482060361420404, 0, 0],
  [5.445220764892785, 0.08739756064091182, 0, 0],
  [7.42555748318834, 0.052228984400379486, 0, 0],
  [9.406126897065857, 0.026638884372877224, 0, 0],
  [11.386985823860664, 0.011595876612829572, 0, 0],
  [13.368187582263898, 0.004307876491458321, 0, 0],
  [15, 0.0008880585113811997, 0, 0],
] as const;

export const LOGO_CENTER: Point = [0.5, 0.5];

export class FlarePipeline {
  private readonly sampler: GPUSampler;
  private readonly blueNoise: GPUTexture;
  private readonly effects: FrameEffects;
  private targets: FlareTargets | undefined;
  private logo: BoundLogo | undefined;
  private size: Point = [1, 1];
  private supersample = 1;
  private disposed = false;

  constructor(private readonly gpu: Gpu, private readonly output: Target) {
    this.sampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.blueNoise = createBlueNoiseTexture(gpu);
    try {
      this.effects = {
        logo: effect(gpu, fullscreen(logoWgsl), { label: "nextjs-flare-logo" }),
        rim: effect(gpu, fullscreen(rimWgsl), { label: "nextjs-flare-rim" }),
        rimBlurH: effect(gpu, fullscreen(blurWgsl), {
          label: "nextjs-flare-rim-horizontal",
        }),
        rimBlurV: effect(gpu, fullscreen(blurWgsl), {
          label: "nextjs-flare-rim-vertical",
        }),
        composite: effect(gpu, fullscreen(compositeWgsl), {
          label: "nextjs-flare-composite",
        }),
      };
    } catch (error) {
      bestEffort(() => this.blueNoise.destroy());
      throw error;
    }
  }

  async replace(
    size: Point,
    supersample: number,
    raster: LogoRaster,
    isStale: () => boolean = () => false
  ): Promise<FlarePlacement | undefined> {
    if (this.disposed) return;
    const nextSize = size.map((value) => Math.max(1, Math.floor(value))) as [
      number,
      number
    ];
    const rebuild =
      !this.targets ||
      nextSize[0] !== this.size[0] ||
      nextSize[1] !== this.size[1] ||
      supersample !== this.supersample;
    const candidate: Array<() => void> = [];

    try {
      const nextTargets = rebuild
        ? createTargets(this.gpu, nextSize, supersample, candidate)
        : this.targets!;
      const nextTexture = this.gpu.gpu.createTexture({
        label: "nextjs-flare-logo-raster",
        size: [raster.width, raster.height],
        format: "rgba8unorm",
        usage: 0x02 | 0x04 | 0x10,
      });
      candidate.push(() => nextTexture.destroy());
      raster.upload(this.gpu, nextTexture);
      if (!this.targets) await this.compile(nextTargets);
      if (this.disposed || isStale()) return;

      const placement = centeredPlacement(
        nextSize[0],
        nextSize[1],
        Math.min(nextSize[0], nextSize[1])
      );
      const nextLogo: BoundLogo = {
        ...raster,
        texture: nextTexture,
        placement,
      };
      const previousTargets = this.targets;
      const previousLogo = this.logo;
      const previousOutputSize = [...this.output.size] as [number, number];

      try {
        this.output.resize(nextSize);
        this.bindTargets(nextTargets);
        this.bindLogo(nextLogo);
      } catch (error) {
        bestEffort(() => this.output.resize(previousOutputSize));
        if (previousTargets)
          bestEffort(() => this.bindTargets(previousTargets));
        if (previousLogo) bestEffort(() => this.bindLogo(previousLogo));
        throw error;
      }

      this.targets = nextTargets;
      this.logo = nextLogo;
      this.size = nextSize;
      this.supersample = supersample;
      candidate.length = 0;
      runCleanups([
        ...(rebuild && previousTargets ? targetCleanups(previousTargets) : []),
        ...(previousLogo ? [() => previousLogo.texture.destroy()] : []),
      ]);
      return placement;
    } finally {
      for (const cleanup of candidate) bestEffort(cleanup);
    }
  }

  setFrameUniforms(
    placement: FlarePlacement,
    light: Point,
    frameIndex: number,
    timeSeconds: number,
    pulseHold: number
  ): void {
    if (!this.targets) return;
    const blurTexel: Point = [
      1 / this.targets.rimA.size[0],
      1 / this.targets.rimA.size[1],
    ];
    this.effects.logo.set({
      params: {
        logoCenter: placement.logoCenter,
        logoScale: placement.logoScale,
      },
    });
    this.effects.rim.set({
      params: {
        light,
        sceneTexel: [1 / this.size[0], 1 / this.size[1]],
        aspect: placement.canvasToLogo,
        spotReach: 0.5,
        spotStroke: 0.9,
      },
    });
    const blurParams = {
      texelSize: blurTexel,
      taps: BLUR_TAPS,
      centerWeight: BLUR_CENTER_WEIGHT,
      tapCount: BLUR_TAPS.length,
    };
    this.effects.rimBlurH.set({
      params: { ...blurParams, direction: [blurTexel[0], 0] },
    });
    this.effects.rimBlurV.set({
      params: { ...blurParams, direction: [0, blurTexel[1]] },
    });
    const pulse = lightPulse(timeSeconds);
    const attenuation = pulse + (1 - pulse) * pulseHold;
    this.effects.composite.set({
      params: {
        light,
        aspect: placement.canvasToLogo,
        logoCenter: placement.logoCenter,
        flareColor: FLARE_COLOR,
        rimIntensity: attenuation,
        extension: 0.6,
        beamIntensity: 0.8 * attenuation,
        filmGrain: 0.03,
        smoothness: 1,
        logoOpacity: 1,
        frameIndex,
        spotFocus: 0.08,
        scatter: 1,
        rimFill: 1,
        verticalEdgeFade: 0.1,
      },
    });
  }

  draw(staticDirty: boolean): void {
    if (!this.targets || this.disposed) return;
    const targets = this.targets;
    frame(this.gpu, (currentFrame) => {
      if (staticDirty) currentFrame.pass(targets.scene, this.effects.logo);
      currentFrame.pass(targets.rim, this.effects.rim);
      currentFrame.pass(targets.rimA, this.effects.rimBlurH);
      currentFrame.pass(targets.rimB, this.effects.rimBlurV);
      currentFrame.pass(this.output, this.effects.composite);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runCleanups([
      () => this.blueNoise.destroy(),
      ...(this.logo ? [() => this.logo!.texture.destroy()] : []),
      ...(this.targets ? targetCleanups(this.targets) : []),
    ]);
  }

  private async compile(targets: FlareTargets): Promise<void> {
    const attempts = [
      () => this.effects.logo.compile(targets.scene),
      () => this.effects.rim.compile(targets.rim),
      () => this.effects.rimBlurH.compile(targets.rimA),
      () => this.effects.rimBlurV.compile(targets.rimB),
      () =>
        this.effects.composite.compile({
          colors: [this.output.format],
          sampleCount: this.output.sampleCount,
        }),
    ];
    const results = await Promise.allSettled(
      attempts.map((attempt) => Promise.resolve().then(attempt))
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private bindTargets(targets: FlareTargets): void {
    this.effects.rim.set({
      linearSampler: this.sampler,
      sceneTexture: targets.scene,
    });
    this.effects.rimBlurH.set({
      linearSampler: this.sampler,
      sourceTexture: targets.rim,
    });
    this.effects.rimBlurV.set({
      linearSampler: this.sampler,
      sourceTexture: targets.rimA,
    });
    this.effects.composite.set({
      linearSampler: this.sampler,
      sceneTexture: targets.scene,
      rimTexture: targets.rim,
      rimBlurTexture: targets.rimB,
      blueNoiseTexture: this.blueNoise,
    });
  }

  private bindLogo(logo: BoundLogo): void {
    const pad = 3;
    this.effects.logo.set({
      logoSampler: this.sampler,
      logoTexture: logo.texture,
      params: {
        logoCenter: logo.placement.logoCenter,
        logoScale: logo.placement.logoScale,
        uvInset: [pad / logo.width, pad / logo.height],
        edge: 1.1,
      },
    });
  }
}

export function backingDimensions(
  width: number,
  height: number,
  dpr: number
): Point {
  const pixelRatio = Math.min(
    Math.max(dpr, 1),
    1.75,
    MAX_RENDER_WIDTH / Math.max(width, 1)
  );
  return [
    Math.max(1, Math.floor(width * pixelRatio)),
    Math.max(1, Math.floor(height * pixelRatio)),
  ];
}

export function logoPixelSize(size: number): [number, number] {
  const aspect = 514 / 624;
  const height = size * LOGO_HEIGHT_RATIO;
  return [
    Math.max(1, Math.round(height * aspect)),
    Math.max(1, Math.round(height)),
  ];
}

export function centeredPlacement(
  width: number,
  height: number,
  reference: number
): FlarePlacement {
  const [logoWidth, logoHeight] = logoPixelSize(reference);
  const logoCenter: Point = [
    0.5 - (GLYPH_CENTER_IN_BOX[0] - 0.5) * (logoWidth / width),
    0.5 - (GLYPH_CENTER_IN_BOX[1] - 0.5) * (logoHeight / height),
  ];
  return {
    logoCenter,
    logoScale: [logoWidth / width, logoHeight / height],
    canvasToLogo: [width / reference, height / reference],
  };
}

export function mapAutonomousLight(
  timeSeconds: number,
  placement: FlarePlacement
): Point {
  const phase = timeSeconds * 0.32;
  const radius = 0.34 + 0.09 * Math.sin(phase * 0.83);
  const local: Point = [
    0.5 + Math.cos(phase) * radius * 1.1,
    0.5 - Math.sin(phase) * radius * 0.85,
  ];
  return [
    placement.logoCenter[0] + (local[0] - 0.5) / placement.canvasToLogo[0],
    placement.logoCenter[1] + (local[1] - 0.5) / placement.canvasToLogo[1],
  ];
}

export function followLight(current: Point, target: Point, dt: number): Point {
  const alpha = 1 - Math.exp(-Math.min(Math.max(dt, 0), 0.05) / 0.3);
  return [
    current[0] + (target[0] - current[0]) * alpha,
    current[1] + (target[1] - current[1]) * alpha,
  ];
}

export function canvasRaster(canvas: HTMLCanvasElement): LogoRaster {
  return {
    width: canvas.width,
    height: canvas.height,
    upload(gpu, texture) {
      gpu.gpu.queue.copyExternalImageToTexture(
        { source: canvas },
        { texture },
        [canvas.width, canvas.height]
      );
    },
  };
}

export function rgbaRaster(
  data: Uint8Array<ArrayBuffer>,
  width: number,
  height: number
): LogoRaster {
  return {
    width,
    height,
    upload(gpu, texture) {
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const upload =
        bytesPerRow === width * 4
          ? data
          : padTextureRows(data, width * 4, bytesPerRow, height);
      gpu.gpu.queue.writeTexture(
        { texture },
        upload,
        { bytesPerRow, rowsPerImage: height },
        [width, height]
      );
    },
  };
}

function createTargets(
  gpu: Gpu,
  size: Point,
  supersample: number,
  owned: Array<() => void>
): FlareTargets {
  const own = (value: Target) => {
    owned.push(() => value.color.destroy());
    return value;
  };
  const full = { size, format: "rgba8unorm" as const };
  return {
    scene: own(
      target(gpu, {
        size: [size[0] * supersample, size[1] * supersample],
        format: "rgba8unorm",
      })
    ),
    rim: own(target(gpu, full)),
    rimA: own(target(gpu, full)),
    rimB: own(target(gpu, full)),
  };
}

function createBlueNoiseTexture(gpu: Gpu): GPUTexture {
  const texture = gpu.gpu.createTexture({
    label: "nextjs-flare-blue-noise-128",
    size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
    format: "r8unorm",
    usage: 0x02 | 0x04,
  });
  try {
    const bytesPerRow = 256;
    gpu.gpu.queue.writeTexture(
      { texture },
      padTextureRows(
        blueNoiseBytes(),
        BLUE_NOISE_SIZE,
        bytesPerRow,
        BLUE_NOISE_SIZE
      ),
      { bytesPerRow, rowsPerImage: BLUE_NOISE_SIZE },
      [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]
    );
    return texture;
  } catch (error) {
    bestEffort(() => texture.destroy());
    throw error;
  }
}

function padTextureRows(
  data: Uint8Array<ArrayBuffer>,
  sourceBytesPerRow: number,
  destinationBytesPerRow: number,
  height: number
): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(destinationBytesPerRow * height);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * sourceBytesPerRow;
    padded.set(
      data.subarray(sourceOffset, sourceOffset + sourceBytesPerRow),
      row * destinationBytesPerRow
    );
  }
  return padded;
}

function lightPulse(timeSeconds: number): number {
  let remaining = Math.max(timeSeconds, 0);
  let index = 0;
  let on = true;
  for (;;) {
    const hold = index === 0 ? 6 : 3 + pulseHash(index) * 3;
    if (remaining < hold) return on ? 1 : PULSE_FLOOR;
    remaining -= hold;
    if (remaining < PULSE_TRANSITION_SECONDS) {
      const progress = remaining / PULSE_TRANSITION_SECONDS;
      const eased = progress * progress * (3 - 2 * progress);
      const raw = on ? 1 - eased : eased;
      return PULSE_FLOOR + (1 - PULSE_FLOOR) * raw;
    }
    remaining -= PULSE_TRANSITION_SECONDS;
    on = !on;
    index += 1;
  }
}

function pulseHash(index: number): number {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function fullscreen(shader: string | { readonly wgsl: string }): string {
  const source = typeof shader === "string" ? shader : shader.wgsl;
  return `${TOP_LEFT_FULLSCREEN_VERTEX}\n${source}`;
}

function targetCleanups(targets: FlareTargets): Array<() => void> {
  return Object.values(targets).map((value) => () => value.color.destroy());
}

export function runCleanups(cleanups: readonly (() => void)[]): void {
  let primary: unknown;
  let failed = false;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      if (!failed) primary = error;
      failed = true;
    }
  }
  if (failed) throw primary;
}

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Cleanup must not replace the active construction or render failure.
  }
}
