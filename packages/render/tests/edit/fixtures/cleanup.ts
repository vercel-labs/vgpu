import { EditableMesh } from "@vgpu/render/edit";

export function mergeDuplicateTetra() {
  const em = EditableMesh.fromArrays({
    positions: new Float32Array([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1, 1.25, 1, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 3, 1, 4, 2, 3, 1, 3, 2]),
  });
  em.gpu.halfEdgeKernel.isSharp[edgeBetween(em, 4, 2)] = 1;
  return em;
}

export function nonManifoldTetra() {
  return EditableMesh.fromArrays({
    positions: new Float32Array([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1, 0, 1.8, 1.3]),
    indices: new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2, 0, 4, 1]),
  });
}

export function bentSmoothPair() {
  return EditableMesh.fromArrays({
    positions: new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0.7]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    useSmooth: new Uint8Array([1, 1]),
    creaseAngle: Math.PI,
  });
}

export function emptyMesh() {
  return EditableMesh.fromArrays({ positions: new Float32Array([]), indices: new Uint32Array([]) });
}

export function edgeBetween(em: ReturnType<typeof EditableMesh.fromArrays>, a: number, b: number): number {
  const k = em.gpu.halfEdgeKernel, lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error("missing edge");
}
