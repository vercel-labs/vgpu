import type { Device } from "@vgpu/core";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh } from "./mesh-types.ts";
import { buildPolyhedronMesh, validatePolyhedron, type PolyhedronSpec } from "./polyhedron-mesh.ts";
import { OCTAHEDRON_SEED } from "./polyhedron-seeds.ts";

const cache = new WeakMap<Device, Map<string, Mesh>>();

export function octahedron(spec: PolyhedronSpec): Mesh {
  validatePolyhedron("octahedron", spec.radius, 24);
  const key = `${spec.radius}`;
  return cachedMesh(cache, spec.device, key, () => buildPolyhedronMesh("octahedron", spec, OCTAHEDRON_SEED, key));
}
