import { effect, frame, sampler, target, type Effect, type Gpu, type Target, type TargetSignature } from 'vgpu';

import blurWgsl from './blur.wgsl';
import compositeWgsl from './composite.wgsl';
import logoWgsl from './logo.wgsl';
import rimWgsl from './rim.wgsl';

import { withTopLeftFullscreen } from './fullscreen';
import type { FlarePlacement, FlareSettings } from './settings';
import { createBlueNoiseTexture } from './textures';
import { setFrameUniforms, type FrameEffects } from './uniforms';

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
  private supersample = 1;
  private readonly sampler: GPUSampler;
  private readonly blueNoiseTexture: GPUTexture;
  private readonly effects: FrameEffects;

  constructor(gpu: Gpu, output: Target) {
    this.gpu = gpu;
    this.output = output;
    this.sampler = sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.blueNoiseTexture = createBlueNoiseTexture(gpu);
    this.effects = {
      logo: effect(gpu, withTopLeftFullscreen(logoWgsl), { label: 'nextjs-flare-logo' }),
      rim: effect(gpu, withTopLeftFullscreen(rimWgsl), { label: 'nextjs-flare-rim' }),
      rimBlurH: effect(gpu, withTopLeftFullscreen(blurWgsl), {
        label: 'nextjs-flare-rim-horizontal',
      }),
      rimBlurV: effect(gpu, withTopLeftFullscreen(blurWgsl), {
        label: 'nextjs-flare-rim-vertical',
      }),
      composite: effect(gpu, withTopLeftFullscreen(compositeWgsl), {
        label: 'nextjs-flare-composite',
      }),
    };
  }

  get ready(): boolean {
    return Boolean(this.targets);
  }

  async resize(size: readonly [number, number], supersample = 1): Promise<boolean> {
    const nextSize = size.map((value) => Math.max(1, Math.floor(value))) as [number, number];
    if (
      nextSize[0] === this.size[0] &&
      nextSize[1] === this.size[1] &&
      this.supersample === supersample &&
      this.targets
    ) {
      return false;
    }
    const needsCompile = !this.targets;
    this.size = nextSize;
    this.supersample = supersample;
    this.output.resize(nextSize);
    this.destroyTargets();
    const full = { size: nextSize, format: 'rgba8unorm' as const };
    // The ink mask is the pipeline's only hard-edged source: rendering it
    // supersampled and letting every consumer's linear sampler box-filter it
    // back down antialiases the glyph diagonals on low-DPR screens. Rim and
    // blur stay at output resolution; they are smooth fields already.
    const scene = {
      size: [nextSize[0] * supersample, nextSize[1] * supersample] as [number, number],
      format: 'rgba8unorm' as const,
    };
    this.targets = {
      scene: target(this.gpu, scene),
      rim: target(this.gpu, full),
      rimA: target(this.gpu, full),
      rimB: target(this.gpu, full),
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
    frame(this.gpu, (frame) => {
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
    this.effects.rim.set({ linearSampler: this.sampler, sceneTexture: targets.scene });
    this.effects.rimBlurH.set({ linearSampler: this.sampler, sourceTexture: targets.rim });
    this.effects.rimBlurV.set({ linearSampler: this.sampler, sourceTexture: targets.rimA });
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
