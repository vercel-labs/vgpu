/**
 * Shared public types with no runtime weight and no dependency on the `Gpu` facade.
 *
 * They live outside `gpu.ts` so feature modules (compute, storage, ping-pong, uniforms, ...)
 * can be imported — and tree-shaken — without pulling the object that owns every factory.
 */
import type { VGPUError } from "./errors.ts";
import type { Target } from "./target.ts";

export interface ComputeOptions {
  readonly label?: string;
  readonly set?: Record<string, unknown>;
  /** Values for WGSL `override` constants, keyed by name (or by numeric id as a string when the override has @id). Immutable after construction. */
  readonly constants?: Readonly<Record<string, number | boolean>>;
  /** Compute entry point to use when the shader has several. Defaults to the first @compute entry point. */
  readonly entry?: string;
}
export interface DispatchOptions {
  /** GPU-driven dispatch: read the workgroup counts from a buffer instead of CPU-side counts. */
  readonly indirect: StorageBuffer | { readonly buffer: StorageBuffer; readonly offset?: number };
}
export interface Compute { set(values: Record<string, unknown>): this; dispatch(x: number, y?: number, z?: number): void; dispatch(opts: DispatchOptions): void }
export type StorageAccess = "read" | "read-write";
export interface StorageOptions {
  /** Binding access for shader reflection. Defaults to "read-write". */
  readonly access?: StorageAccess;
  /** Adds the "indirect" buffer usage so the buffer can supply GPU-read draw/dispatch arguments. Defaults to false. */
  readonly indirect?: boolean;
}
export interface StorageBuffer { readonly size: number; readonly access: StorageAccess; read(): Promise<ArrayBuffer>; write(data: BufferSource): void }
export interface PingPongTargets { readonly read: Target; readonly write: Target; swap(): void }
export interface PingPongStorage { readonly read: StorageBuffer; readonly write: StorageBuffer; swap(): void }
export interface SharedUniforms<T extends Record<string, unknown> = Record<string, unknown>> { set(values: Partial<T>): void }
export type GpuErrorListener = (error: VGPUError) => void;
