import type { Texture } from '@vgpu/core';
import type { BrushState, SceneTunables as LightTunables } from './light-sources-pass';

export interface LightSourcesRaw {
  /** rgba16float core GPUTexture; pass to facade draws via draw.set({ light_sources_tex: texture }). */
  readonly texture: Texture | GPUTexture;
  /** encode the light-sources+emitters pass into a raw command submit for this frame. */
  encode(args: {
    brush: BrushState;
    time: number;
    tunables: LightTunables;
    renderBlackOccluder?: boolean;
  }): void;
  destroy(): void;
}

export function createLightSourcesRaw(gpu: any, opts: {
  size: readonly [number, number];
  ledStorage: GPUBuffer;
  triangle: any;
  ledRadius: number;
  ledShape: any;
}): LightSourcesRaw;
