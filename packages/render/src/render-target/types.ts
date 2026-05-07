import type { Device, Texture } from "@vgpu/core";
import type { Material } from "../domain/material.ts";
import type { Mesh } from "../domain/mesh.ts";

/** Render target wrapper for color, depth, and optional MSAA attachments. */
export interface RenderTarget {
  readonly color: Texture;
  readonly colors: readonly [Texture];
  readonly depth?: Texture;
  readonly size: readonly [number, number];
  readonly format: GPUTextureFormat;
  readonly sampleCount: 1 | 4;
  readonly label?: string;
  readonly gpu: RenderTargetGpu;
}

/** Raw GPU attachments and pass descriptor fragments owned by a render target. */
export interface RenderTargetGpu {
  readonly colorAttachment: GPURenderPassColorAttachment;
  readonly depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
  readonly colorTexture: GPUTexture;
  readonly resolveTexture?: GPUTexture;
  readonly depthTexture?: GPUTexture;
}

/** Options for creating a render target. */
export interface RenderTargetSpec {
  readonly device: Device;
  readonly size: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
  readonly clearColor?: GPUColorDict | readonly [number, number, number, number];
}

/** Supported color target inputs for pass(). */
export type PassTarget = RenderTarget | Texture | GPUTextureView;

/** Options for rendering one material and mesh into a target. */
export interface PassSpec {
  readonly material: Material;
  readonly mesh: Mesh;
  readonly target: PassTarget;
  readonly depthTarget?: Texture | GPUTextureView;
  readonly clearColor?: GPUColorDict | readonly [number, number, number, number];
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
