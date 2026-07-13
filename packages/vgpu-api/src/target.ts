import type { Texture, ResourceDestroyCallback, ResourceIdentity, UnsubscribeResourceDestroy } from "@vgpu/core";

export interface TargetOptions {
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly colors?: readonly { readonly format: GPUTextureFormat }[];
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
}

export interface Target {
  readonly gpu: unknown;
  readonly size: readonly [number, number];
  readonly texelSize: readonly [number, number];
  readonly color: Texture;
  readonly colors: readonly [Texture, ...Texture[]];
  readonly depth?: Texture;
  readonly format: GPUTextureFormat;
  readonly sampleCount: 1 | 4;
  readonly resourceIdentity: ResourceIdentity;
  resize(size: readonly [number, number]): void;
  read(): Promise<Uint8Array>;
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy;
  renderPassDescriptor(clear?: GPUColor | readonly [number, number, number, number]): GPURenderPassDescriptor;
}

export { OffscreenTarget } from "./target-offscreen.ts";
export { ScreenTarget } from "./target-screen.ts";
