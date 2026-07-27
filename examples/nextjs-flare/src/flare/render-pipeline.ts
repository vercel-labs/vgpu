import type { Effect, Gpu, Target, TargetSignature } from "vgpu";
import { withTopLeftFullscreen } from "./fullscreen-shader.ts";
import {
  blurShader,
  compositeShader,
  logoShader,
  rimShader,
} from "./shaders.ts";
import type { FlarePlacement, FlareSettings } from "./settings.ts";
import { createBlueNoiseTexture } from "./textures.ts";
import { setFrameUniforms, type FrameEffects } from "./uniforms.ts";

export type FlareTargets = {
  scene: Target;
  rim: Target;
  rimA: Target;
  rimB: Target;
};

export class FlarePipeline {
  private readonly gpu: Gpu;
  private readonly output: Target;
  private targets: FlareTargets | undefined;
  private size: readonly [number, number] = [1, 1];
  private readonly sampler: GPUSampler;
  private readonly blueNoiseTexture: GPUTexture;
  private readonly effects: FrameEffects;

  constructor(gpu: Gpu, output: Target) {
    this.gpu = gpu;
    this.output = output;
    this.sampler = gpu.sampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.blueNoiseTexture = createBlueNoiseTexture(gpu);
    this.effects = {
      logo: gpu.effect(withTopLeftFullscreen(logoShader), {
        label: "nextjs-flare-logo",
      }),
      rim: gpu.effect(withTopLeftFullscreen(rimShader), {
        label: "nextjs-flare-rim",
      }),
      rimBlurH: gpu.effect(withTopLeftFullscreen(blurShader), {
        label: "nextjs-flare-rim-horizontal",
      }),
      rimBlurV: gpu.effect(withTopLeftFullscreen(blurShader), {
        label: "nextjs-flare-rim-vertical",
      }),
      composite: gpu.effect(withTopLeftFullscreen(compositeShader), {
        label: "nextjs-flare-composite",
      }),
    };
  }

  get ready(): boolean {
    return Boolean(this.targets);
  }

  async resize(size: readonly [number, number]): Promise<boolean> {
    const nextSize = size.map((value) => Math.max(1, Math.floor(value))) as [
      number,
      number,
    ];
    if (
      nextSize[0] === this.size[0] &&
      nextSize[1] === this.size[1] &&
      this.targets
    )
      return false;
    const needsCompile = !this.targets;
    this.size = nextSize;
    this.output.resize(nextSize);
    this.destroyTargets();
    const full = { size: nextSize, format: "rgba8unorm" as const };
    this.targets = {
      scene: this.gpu.target(full),
      rim: this.gpu.target(full),
      rimA: this.gpu.target(full),
      rimB: this.gpu.target(full),
    };
    if (needsCompile) {
      await Promise.all([
        this.effects.logo.compile(this.targets.scene),
        this.effects.rim.compile(this.targets.rim),
        this.effects.rimBlurH.compile(this.targets.rimA),
        this.effects.rimBlurV.compile(this.targets.rimB),
        this.effects.composite.compile(this.outputSignature()),
      ]);
    }
    this.bindTargets();
    return true;
  }

  bindLogoTexture(
    texture: GPUTexture,
    width: number,
    height: number,
    placement: FlarePlacement,
  ): void {
    const pad = 3;
    this.effects.logo.set({
      logoSampler: this.sampler,
      logoTexture: texture,
      params: {
        logoCenter: placement.logoCenter,
        logoScale: placement.logoScale,
        uvInset: [pad / width, pad / height],
        edge: 1.1,
      },
    });
  }

  setFrameUniforms(
    settings: FlareSettings,
    placement: FlarePlacement,
    light: readonly [number, number],
    frameIndex: number,
    timeSeconds: number,
    pulseHold: number,
  ): void {
    if (!this.targets) return;
    setFrameUniforms(
      this.effects,
      this.size,
      this.targets.rimA.size,
      settings,
      placement,
      light,
      frameIndex,
      timeSeconds,
      pulseHold,
    );
  }

  draw(staticDirty: boolean): void {
    if (!this.targets) return;
    const targets = this.targets;
    this.gpu.frame((frame) => {
      if (staticDirty) frame.pass(targets.scene, this.effects.logo);
      frame.pass(targets.rim, this.effects.rim);
      frame.pass(targets.rimA, this.effects.rimBlurH);
      frame.pass(targets.rimB, this.effects.rimBlurV);
      frame.pass(this.output, this.effects.composite);
    });
  }

  dispose(): void {
    this.blueNoiseTexture.destroy();
    this.destroyTargets();
  }

  private outputSignature(): TargetSignature {
    return {
      colors: [this.output.format],
      sampleCount: this.output.sampleCount,
    };
  }

  private bindTargets(): void {
    if (!this.targets) return;
    const targets = this.targets;
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
      blueNoiseTexture: this.blueNoiseTexture,
    });
  }

  private destroyTargets(): void {
    if (!this.targets) return;
    for (const target of Object.values(this.targets)) target.color.destroy();
    this.targets = undefined;
  }
}
