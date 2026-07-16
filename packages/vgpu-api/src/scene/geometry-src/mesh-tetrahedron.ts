import type { Device } from "@vgpu/core";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh } from "./mesh-types.ts";
import { buildPolyhedronMesh, validatePolyhedron, type PolyhedronSpec } from "./polyhedron-mesh.ts";
import { TETRAHEDRON_SEED } from "./polyhedron-seeds.ts";

export type { PolyhedronSpec } from "./polyhedron-mesh.ts";

const cache = new WeakMap<Device, Map<string, Mesh>>();

export function tetrahedron(spec: PolyhedronSpec): Mesh {
  validatePolyhedron("tetrahedron", spec.radius, 12);
  const key = `${spec.radius}`;
  return cachedMesh(cache, spec.device, key, () => buildPolyhedronMesh("tetrahedron", spec, TETRAHEDRON_SEED, key));
}
