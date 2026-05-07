import type { Device } from "@vgpu/core";
import type { Vec3 } from "wgpu-matrix";
import { buildKernel } from "./half-edge-build.ts";
import { bakeRenderMesh } from "./half-edge-bake.ts";
import { makeElementSet } from "./element-set.ts";
import { selection } from "./selection.ts";
import type { EditableMesh as EditableMeshValue, FromArraysOptions } from "./types.ts";
import type { HalfEdgeKernel } from "./half-edge-kernel.ts";

import { unwrapKernel, wrapKernel } from "./kernel-handle.ts";
export const EditableMesh = {
  fromArrays(opts: FromArraysOptions): EditableMeshValue { return wrap(buildKernel(opts), opts); },
  toRenderMesh(em: EditableMeshValue, opts: { readonly device: Device }) { return bakeRenderMesh(unwrapKernel(em.gpu.halfEdgeKernel), opts.device); },
};

export function wrap(k: HalfEdgeKernel, opts: FromArraysOptions): EditableMeshValue {
  const hard = selection("edge", Array.from(k.isSharp, (v, i) => v ? i : -1).filter((i) => i >= 0));
  const em: EditableMeshValue = {
    vertexCount: k.vertexCount, edgeCount: k.edgeCount, faceCount: k.faceCount, bounds: bounds(k.positions),
    vertices: makeElementSet(k, "vertex"), edges: makeElementSet(k, "edge"), faces: makeElementSet(k, "face"),
    isManifold: Array.from(k.edgeFaceB).every((f) => f >= 0), hasUVs: !!opts.uvs, hasNormals: !!opts.normals, hasVertexColors: !!opts.colors,
    hardEdges: hard, gpu: Object.freeze({ halfEdgeKernel: wrapKernel(k) }),
    toRenderMesh(renderOpts) { return bakeRenderMesh(k, renderOpts.device); },
  };
  return Object.freeze(em);
}

function bounds(p: Float32Array): { readonly min: Vec3; readonly max: Vec3 } {
  const min = new Float32Array([Infinity, Infinity, Infinity]), max = new Float32Array([-Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[i + a]); max[a] = Math.max(max[a], p[i + a]); }
  return Object.freeze({ min: min as Vec3, max: max as Vec3 });
}
