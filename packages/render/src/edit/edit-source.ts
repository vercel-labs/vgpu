import type { Mesh } from "../mesh-like.ts";

export interface EditSource {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly sharpEdges: Uint8Array;
  readonly useSmooth: Uint8Array;
}

const sourceKey = Symbol.for("@vgpu/render/edit-source");

type MeshWithSource = Mesh & { readonly [sourceKey]?: EditSource };

export function sourceOf(mesh: Mesh): EditSource | undefined {
  return (mesh as MeshWithSource)[sourceKey];
}

export function attachSource<T extends Mesh>(mesh: T, source: EditSource): T {
  Object.defineProperty(mesh, sourceKey, { value: source, enumerable: false });
  return mesh;
}
