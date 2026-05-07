import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import type { Mesh } from "../domain/mesh.ts";

declare const kernelBrand: unique symbol;
export type KernelHandle = { readonly [kernelBrand]: never };
export type ElementDomain = "vertex" | "edge" | "face" | "loop";
export interface ElementSelection { readonly domain: ElementDomain; readonly indices: ReadonlyArray<number>; readonly count: number; readonly ordered?: boolean }
export interface ScoredSelection { readonly domain: ElementDomain; readonly entries: ReadonlyArray<{ readonly index: number; readonly score: number }>; top(): ElementSelection; topN(n: number): ElementSelection; threshold(min: number): ElementSelection; bottom(): ElementSelection; bottomN(n: number): ElementSelection }
export interface VertexView { readonly index: number; readonly position: Vec3; readonly normal: Vec3; readonly valence: number; readonly isBoundary: boolean; readonly isManifold: boolean }
export interface EdgeView { readonly index: number; readonly midpoint: Vec3; readonly length: number; readonly direction: Vec3; readonly vertexA: number; readonly vertexB: number; readonly faceA: number | null; readonly faceB: number | null; readonly isBoundary: boolean; readonly isManifold: boolean; readonly isSharp: boolean }
export interface FaceView { readonly index: number; readonly center: Vec3; readonly normal: Vec3; readonly area: number; readonly vertexCount: number; readonly vertexIndices: ReadonlyArray<number>; readonly edgeIndices: ReadonlyArray<number>; readonly useSmooth: boolean }
export type ElementView<D extends ElementDomain> = D extends "vertex" ? VertexView : D extends "edge" ? EdgeView : D extends "face" ? FaceView : never;
export interface ElementSet<D extends ElementDomain> { readonly domain: D; readonly count: number; where(pred: (e: ElementView<D>) => boolean): ElementSelection; scoreBy(score: (e: ElementView<D>) => number): ScoredSelection; byIndex(indices: readonly number[]): ElementSelection; all(): ElementSelection; none(): ElementSelection; loop(seedEdge: number): D extends "edge" ? ElementSelection : never; ring(seedEdge: number): D extends "edge" ? ElementSelection : never; grow(sel: ElementSelection, layers?: number): ElementSelection; shrink(sel: ElementSelection, layers?: number): ElementSelection; boundaryOf(sel: ElementSelection): ElementSelection; connectedComponentOf(seed: number): ElementSelection }
export interface EditableMesh { readonly vertexCount: number; readonly edgeCount: number; readonly faceCount: number; readonly bounds: { readonly min: Vec3; readonly max: Vec3 }; readonly vertices: ElementSet<"vertex">; readonly edges: ElementSet<"edge">; readonly faces: ElementSet<"face">; readonly isManifold: boolean; readonly hasUVs: boolean; readonly hasNormals: boolean; readonly hasVertexColors: boolean; readonly hardEdges: ElementSelection; readonly gpu: { readonly halfEdgeKernel: KernelHandle }; toRenderMesh(opts: { readonly device: Device }): Mesh }
export interface FromArraysOptions { readonly positions: Float32Array; readonly normals?: Float32Array; readonly uvs?: Float32Array; readonly colors?: Float32Array; readonly indices?: Uint16Array | Uint32Array; readonly sharpEdges?: Uint8Array; readonly useSmooth?: Uint8Array; readonly creaseAngle?: number }
export interface ToEditableOptions { readonly creaseAngle?: number }
