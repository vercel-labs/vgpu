import { EditableMesh, type EditableMeshValue, type ElementSelection } from "@vgpu/render/edit";

export function openCube(): EditableMeshValue {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const i = [0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  return EditableMesh.fromArrays({ positions: new Float32Array(p), indices: new Uint32Array(i) });
}

export function twoPlates(): EditableMeshValue {
  const p = [-1, -1, -0.55, 1, -1, -0.55, 1, 1, -0.55, -1, 1, -0.55, -1, -1, 0.55, 1, -1, 0.55, 1, 1, 0.55, -1, 1, 0.55];
  const i = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  return EditableMesh.fromArrays({ positions: new Float32Array(p), indices: new Uint32Array(i) });
}

export function loopByVertices(em: EditableMeshValue, verts: readonly number[]): ElementSelection {
  const k = em.gpu.halfEdgeKernel, out: number[] = [];
  for (let i = 0; i < verts.length; i++) out.push(edgeBetween(em, verts[i], verts[(i + 1) % verts.length]));
  return Object.freeze({ domain: "edge", indices: Object.freeze(out), count: out.length, ordered: true }) as ElementSelection;
}

export function topHoleLoop(em: EditableMeshValue): ElementSelection { return loopByVertices(em, [4, 5, 6, 7]); }
export function plateLoops(em: EditableMeshValue): ElementSelection {
  const a = loopByVertices(em, [0, 1, 2, 3]).indices, b = loopByVertices(em, [4, 5, 6, 7]).indices;
  return Object.freeze({ domain: "edge", indices: Object.freeze([...a, ...b]), count: a.length + b.length, ordered: true }) as ElementSelection;
}

function edgeBetween(em: EditableMeshValue, a: number, b: number): number {
  const k = em.gpu.halfEdgeKernel, lo = Math.min(a, b), hi = Math.max(a, b);
  for (let e = 0; e < k.edgeCount; e++) if (k.edgeVertexA[e] === lo && k.edgeVertexB[e] === hi) return e;
  throw new Error(`missing edge ${a}:${b}`);
}
