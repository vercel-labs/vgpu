/**
 * What a mesh recipe is, without knowing a single primitive.
 *
 * A recipe is a frozen `{ kind, props }` value — pure CPU data, safe to hold in a scene tree and to
 * fingerprint — that carries its own `build()`. `geometry(gpu, recipe)` calls it and never imports a
 * generator: there is no central `kind -> factory` table anywhere, so the only primitive a program
 * links is the one whose recipe it actually mentions. `box()` costs `mesh-box.ts`, nothing else.
 *
 * The module holds only the contract and the mesh -> descriptor conversion shared by all recipes.
 */
import type { Device } from "@vgpu/core";
import type { GeometryOptions } from "./geometry-descriptor.ts";
import type { Mesh as MeshPrimitive } from "./geometry-src/mesh-types.ts";

/**
 * Structural view of any recipe, as the low-level factory sees it: something that knows how to
 * describe itself as vertex/index buffers when a device is finally available.
 */
export interface GeometryRecipe {
  readonly kind: string;
  readonly props: object;
  /** @internal Uploads the primitive for `device` and describes it as a low-level descriptor. */
  build(device: Device): GeometryOptions;
}

/** A recipe of a known kind, with its props typed. `box()` returns `GeometryRecipeOf<"box", BoxOptions>`. */
export interface GeometryRecipeOf<K extends string, P extends object> extends GeometryRecipe {
  readonly kind: K;
  readonly props: Readonly<P>;
}

/**
 * Builds the recipe value for one primitive: freezes the props and closes over the generator the
 * calling module imported. Nothing is generated here — `build()` runs on the first upload, so a
 * recipe parked in a scene node stays a couple of objects until something asks for its buffers.
 */
export function recipe<K extends string, P extends object>(
  kind: K,
  props: P,
  generate: (device: Device, props: Readonly<P>) => MeshPrimitive,
): GeometryRecipeOf<K, P> {
  const frozen = Object.freeze({ ...props }) as Readonly<P>;
  return Object.freeze({
    kind,
    props: frozen,
    build: (device: Device) => meshGeometryOptions(generate(device, frozen)),
  });
}

/**
 * Describes a generated mesh as a low-level descriptor: position at location 0, normal at 1, uv at
 * 2. The buffers are handed over as caller-owned (`buffer`, not `data`) because the primitive cache
 * owns them per device — the geometry borrows them and destroys nothing on its way out.
 */
export function meshGeometryOptions(primitive: MeshPrimitive): GeometryOptions {
  const attrs = primitive.attributes;
  const attributes: Record<string, GPUVertexFormat | { readonly format: GPUVertexFormat; readonly offset?: number; readonly location?: number }> = {
    position: { ...attrs.position, location: 0 },
  };
  if (attrs.normal) attributes.normal = { ...attrs.normal, location: 1 };
  if (attrs.uv) attributes.uv = { ...attrs.uv, location: 2 };
  return {
    buffers: [{
      buffer: primitive.gpu?.vertexBuffer ?? primitive.vertexBuffer.gpu,
      stride: attrs.stride,
      attributes,
    }],
    vertexCount: primitive.vertexCount,
    indexBuffer: primitive.gpu?.indexBuffer ?? primitive.indexBuffer?.gpu,
    indexFormat: primitive.indexFormat,
    indexCount: primitive.indexCount,
  };
}
