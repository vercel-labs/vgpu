/**
 * Nominal protocols the draw path resolves at build/encode time, kept in a leaf module that imports
 * nothing at runtime.
 *
 * The draw path must recognize values produced by optional features — a shared uniforms block bound
 * to a reflected buffer binding, a geometry resolving its attributes against a vertex entry point —
 * without importing those features. An `instanceof` check or a symbol declared next to the feature
 * costs the whole module: a fullscreen effect that binds no uniforms and owns no vertex buffer used
 * to link `uniforms.ts` + `uniforms-layout.ts` (through `set-resources.ts`) and the geometry
 * descriptor (through `draw.ts`) anyway.
 *
 * Same shape as `frame-protocols.ts`: package-private symbols, no registration by side effect (the
 * value carries its own implementation), and the feature modules import the symbol — not the other
 * way around — so the dependency points at this leaf.
 */
import type { BindingInfo, EntryPointInputInfo } from "@vgpu/wgsl/reflect-source";
import type { NormalizedBindingResource } from "./set-resources.ts";
import type { TargetSignature } from "./target.ts";

/** @internal Implemented by values that bind themselves to a reflected buffer binding. */
export const BINDING_RESOURCE = Symbol("vgpu.bindingResource");

/**
 * A value that knows how to bind itself, such as the shared uniforms block. It adopts or validates
 * the reflected layout and returns the resource plus the identity the bind group cache keys on.
 */
export interface BindingResourceProvider {
  [BINDING_RESOURCE](binding: BindingInfo, sourceHint: string): NormalizedBindingResource;
}

/** Narrows a user-supplied binding value to the protocol, or `undefined` for anything else. */
export function bindingResourceOf(value: unknown): BindingResourceProvider | undefined {
  const method = typeof value === "object" && value !== null ? (value as Partial<BindingResourceProvider>)[BINDING_RESOURCE] : undefined;
  return typeof method === "function" ? (value as BindingResourceProvider) : undefined;
}

/** @internal Implemented by canvas-backed surfaces so resource binding can reject them nominally. */
export const SURFACE_TARGET = Symbol("vgpu.surfaceTarget");

/** A canvas Surface marker kept here so compute-only binding code does not import surface.ts. */
export interface SurfaceTargetProtocol {
  readonly [SURFACE_TARGET]: true;
}

/** Recognizes a canvas Surface without touching any of its attachment getters. */
export function isSurfaceTarget(value: unknown): value is SurfaceTargetProtocol {
  return typeof value === "object" && value !== null
    && (value as Partial<SurfaceTargetProtocol>)[SURFACE_TARGET] === true;
}

/** @internal Implemented by targets whose render signature does not require attachment access. */
export const TARGET_SIGNATURE = Symbol("vgpu.targetSignature");

/** A target that can expose immutable render configuration without acquiring its attachments. */
export interface TargetSignatureProvider {
  [TARGET_SIGNATURE](): TargetSignature;
}

/** Returns configured render metadata without importing or recognizing the target implementation. */
export function targetSignatureOf(value: unknown): TargetSignature | undefined {
  const method = typeof value === "object" && value !== null
    ? (value as Partial<TargetSignatureProvider>)[TARGET_SIGNATURE]
    : undefined;
  return typeof method === "function" ? method.call(value) : undefined;
}

/** @internal Resolves named geometry attributes against reflected shader inputs. */
export const geometryLayoutResolver = Symbol("vgpu.geometry.layoutResolver");

/** @internal Implemented by v2 geometries and slices for draw-time layout resolution. */
export interface GeometryLayoutResolvable {
  /** Resolves and validates concrete shader locations for a vertex entry point. */
  [geometryLayoutResolver](inputs: readonly EntryPointInputInfo[], where: string): readonly GPUVertexBufferLayout[];
}

/** @internal Asserts that captured geometry buffers are still valid immediately before use. */
export const geometryLiveness = Symbol("vgpu.geometry.liveness");

/** @internal Implemented by owned geometries and slices. */
export interface GeometryLive {
  [geometryLiveness](where: string): void;
}

/** Returns the optional geometry liveness protocol without importing its implementation. */
export function geometryLivenessOf(value: unknown): GeometryLive | undefined {
  const method = typeof value === "object" && value !== null
    ? (value as Partial<GeometryLive>)[geometryLiveness]
    : undefined;
  return typeof method === "function" ? value as GeometryLive : undefined;
}
