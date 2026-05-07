import type { Device } from "@vgpu/core";
import type { Mesh } from "./mesh-types.ts";

export function cachedMesh<TKey extends string | number>(
  cache: WeakMap<Device, Map<TKey, Mesh>>,
  device: Device,
  key: TKey,
  build: () => Mesh,
): Mesh {
  let meshes = cache.get(device);
  if (!meshes) {
    meshes = new Map<TKey, Mesh>();
    cache.set(device, meshes);
  }
  const cached = meshes.get(key);
  if (cached) return cached;
  const mesh = build();
  meshes.set(key, mesh);
  return mesh;
}
