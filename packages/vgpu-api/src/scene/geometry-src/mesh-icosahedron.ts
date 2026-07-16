import type { Device } from "@vgpu/core";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh } from "./mesh-types.ts";
import { buildPolyhedronMesh, validatePolyhedron, type PolyhedronSpec } from "./polyhedron-mesh.ts";
import { ICOSAHEDRON_SEED } from "./polyhedron-seeds.ts";

const cache = new WeakMap<Device, Map<string, Mesh>>();

export function icosahedron(spec: PolyhedronSpec): Mesh {
  validatePolyhedron("icosahedron", spec.radius, 60);
  const key = `${spec.radius}`;
  return cachedMesh(cache, spec.device, key, () => buildPolyhedronMesh("icosahedron", spec, ICOSAHEDRON_SEED, key));
}
