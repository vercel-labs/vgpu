import type { Device } from "@vgpu/core";
import { cachedMesh } from "./mesh-cache.ts";
import type { Mesh } from "./mesh-types.ts";
import { buildPolyhedronMesh, validatePolyhedron, type PolyhedronSpec } from "./polyhedron-mesh.ts";
import { DODECAHEDRON_SEED } from "./polyhedron-seeds.ts";

const cache = new WeakMap<Device, Map<string, Mesh>>();

export function dodecahedron(spec: PolyhedronSpec): Mesh {
  validatePolyhedron("dodecahedron", spec.radius, 108);
  const key = `${spec.radius}`;
  return cachedMesh(cache, spec.device, key, () => buildPolyhedronMesh("dodecahedron", spec, DODECAHEDRON_SEED, key));
}
