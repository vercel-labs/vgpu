import type { Device, Texture } from "@vgpu/core";
import type { Material } from "../domain/material.ts";
import type { Mesh } from "../domain/mesh.ts";

/** Render target wrapper for color, depth, and optional MSAA attachments. */
export interface RenderTarget {
  readonly color: Texture;
  readonly colors: readonly [Texture, ...Texture[]];
  readonly depth?: Texture;
  readonly size: readonly [number, number];
  readonly format: GPUTextureFormat;
  readonly sampleCount: 1 | 4;
  readonly label?: string;
  readonly gpu: RenderTargetGpu;
}

/** Raw GPU attachments and pass descriptor fragments owned by a render target. */
export interface RenderTargetGpu {
  readonly colorAttachments: readonly GPURenderPassColorAttachment[];
  /** @deprecated use `colorAttachments[0]`; alias retained for one deprecation cycle. */
  readonly colorAttachment: GPURenderPassColorAttachment;
  readonly depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
  readonly colorTexture: GPUTexture;
  readonly colorTextures: readonly GPUTexture[];
  readonly resolveTexture?: GPUTexture;
  readonly depthTexture?: GPUTexture;
}

export type ClearColor = GPUColorDict | readonly [number, number, number, number];

/** Options for creating a single-color render target. */
export interface RenderTargetSpec {
  readonly device: Device;
  readonly size: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
  readonly clearColor?: ClearColor;
}

/** Per-attachment options for creating a multi-color render target. */
export interface ColorAttachmentSpec {
  readonly format: GPUTextureFormat;
  readonly clearColor?: ClearColor;
  readonly label?: string;
}

/** Options for creating a multi-color render target. */
export interface RenderTargetMultiSpec<Specs extends readonly ColorAttachmentSpec[] = readonly ColorAttachmentSpec[]> {
  readonly device: Device;
  readonly size: readonly [number, number];
  readonly colors: readonly [...Specs];
  readonly depth?: boolean | GPUTextureFormat;
  readonly label?: string;
}

/** RenderTarget narrowed to the tuple length of a RenderTargetMultiSpec. */
export type RenderTargetN<Specs extends readonly ColorAttachmentSpec[]> =
  Omit<RenderTarget, "colors" | "format"> & {
    readonly colors: { readonly [K in keyof Specs]: Texture };
    readonly format: Specs extends readonly [infer First extends ColorAttachmentSpec, ...ColorAttachmentSpec[]]
      ? First["format"]
      : GPUTextureFormat;
  };

/** Supported color target inputs for pass(). */
export type PassTarget = RenderTarget | Texture | GPUTextureView;

/** Options for rendering one material and mesh into a target. */
export interface PassSpec {
  readonly material: Material;
  readonly mesh: Mesh;
  readonly target: PassTarget;
  readonly depthTarget?: Texture | GPUTextureView;
  readonly clearColor?: ClearColor;
  readonly colorLoadOp?: "clear" | "load";
  readonly depthLoadOp?: "clear" | "load";
  readonly depthClearValue?: number;
  readonly viewport?: readonly [number, number, number, number];
  readonly scissor?: readonly [number, number, number, number];
  readonly encoder?: GPUCommandEncoder;
  /**
   * Reserved for v2: when `material()` gains texture/sampler bindings, this
   * field will accept a typed binding map. Today it is intentionally typed
   * `never[]`, so the field shape exists without accepting any value. Forward-
   * compatibility only — do not pass anything here in v1.
   */
  readonly bindings?: never[];
}
