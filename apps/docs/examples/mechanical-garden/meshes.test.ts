import { describe, expect, it } from "vitest";

import { buildPartMeshes, MATERIAL, MESH_VERTEX_FLOATS, type MeshData } from "./meshes";

/**
 * Edges of the triangles whose vertices all use `material`, after welding positions that agree to
 * a micrometre, mapped to how many triangles use each. Triangles collapsed by the weld (at poles) are skipped.
 */
function weldedEdgeUse(mesh: MeshData, material?: number): Map<string, number> {
  const { vertices, indices } = mesh;
  const ids = new Map<string, number>();
  const weld = (index: number) => {
    const v = index * MESH_VERTEX_FLOATS;
    const key = [0, 1, 2].map((k) => Math.round(vertices[v + k]! * 1e6)).join(",");
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  };
  const uses = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const corners = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    if (material !== undefined && corners.some((c) => vertices[c * MESH_VERTEX_FLOATS + 6] !== material)) continue;
    const [a, b, c] = corners.map(weld) as [number, number, number];
    if (a === b || b === c || c === a) continue;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = p! < q! ? `${p}-${q}` : `${q}-${p}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

function openEdges(uses: Map<string, number>): number {
  let open = 0;
  for (const count of uses.values()) if (count !== 2) open++;
  return open;
}

describe("part meshes", () => {
  const meshes = buildPartMeshes();

  it("closes the pale top plate: no slit along its seam column or at its poles", () => {
    const uses = weldedEdgeUse(meshes.shell, MATERIAL.panel);
    expect(uses.size).toBeGreaterThan(100);
    expect(openEdges(uses)).toBe(0);
  });

  it("builds every robot part as closed surfaces", () => {
    for (const [name, mesh] of Object.entries(meshes)) {
      expect({ name, open: openEdges(weldedEdgeUse(mesh)) }).toEqual({ name, open: 0 });
    }
  });
});
