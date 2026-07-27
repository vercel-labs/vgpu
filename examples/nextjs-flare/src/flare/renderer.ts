import type { Gpu, Target } from "vgpu";
import { FlarePipeline } from "./render-pipeline.ts";
import type { FlarePlacement, FlareSettings } from "./settings.ts";
import { createLogoTexture, uploadLogoTextureRgba } from "./textures.ts";

export class FlareRenderer {
  private readonly gpu: Gpu;
  private readonly pipeline: FlarePipeline;
  private settings: FlareSettings;
  private logoTexture: GPUTexture | undefined;
  private frameIndex = 0;
  private placement: FlarePlacement = {
    logoCenter: [0.5, 0.5],
    logoScale: [0.539, 0.62],
    canvasToLogo: [1, 1],
  };
  private staticDirty = true;
  private disposed = false;

  constructor(gpu: Gpu, output: Target, settings: FlareSettings) {
    this.gpu = gpu;
    this.settings = settings;
    this.pipeline = new FlarePipeline(gpu, output);
  }

  async resize(size: readonly [number, number]): Promise<void> {
    if (await this.pipeline.resize(size)) this.staticDirty = true;
  }

  uploadLogoRgba(data: Uint8Array, width: number, height: number): void {
    this.logoTexture?.destroy();
    this.logoTexture = createLogoTexture(this.gpu, width, height);
    uploadLogoTextureRgba(this.gpu, this.logoTexture, data, width, height);
    this.pipeline.bindLogoTexture(this.logoTexture, width, height, this.placement);
    this.staticDirty = true;
  }

  setPlacement(placement: FlarePlacement): void {
    if (placement !== this.placement) this.staticDirty = true;
    this.placement = placement;
  }

  setSettings(settings: FlareSettings): void {
    this.settings = settings;
  }

  render(
    time: number,
    light: readonly [number, number],
    pulseHold = 0,
    frameIndex = this.frameIndex,
  ): void {
    if (this.disposed || !this.pipeline.ready || !this.logoTexture) return;
    this.pipeline.setFrameUniforms(
      this.settings,
      this.placement,
      light,
      frameIndex,
      time,
      pulseHold,
    );
    this.pipeline.draw(this.staticDirty);
    this.staticDirty = false;
    this.frameIndex = frameIndex + 1;
  }

  async settled(): Promise<void> {
    await this.gpu.settled();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.logoTexture?.destroy();
    this.pipeline.dispose();
  }
}
