import { Atmosphere, Camera } from "./atmosphere-common.wgsl";
import { TERRAIN_NEAR, terrainMeshVertex } from "./terrain.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<uniform> mesh: TerrainMesh;
@group(0) @binding(3) var terrainMap: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;

/** The columns of the ring grid this frame draws (terrainSector in camera.ts). */
struct TerrainMesh { columnOffset: u32, columns: u32 };

/**
 * Depth prepass of the terrain from the camera (terrainMeshVertex in terrain.wgsl builds the surface); scene.wgsl
 * shades it once per pixel from the depth it leaves behind. Reversed-Z with an infinite far plane: depth =
 * TERRAIN_NEAR / view depth keeps precision from 1 m out to 400 km.
 */
@vertex fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> @builtin(position) vec4f {
  let fromGround = terrainMeshVertex(vertexIndex, instanceIndex, mesh.columnOffset, atmosphere.groundRadius, terrainMap, lutSampler);
  // The camera sits on the axis at its altitude above the ground point the grid is relative to.
  let relative = fromGround - vec3f(0.0, camera.position.y - atmosphere.groundRadius, 0.0);
  let view = vec3f(dot(relative, camera.right), dot(relative, camera.up), dot(relative, camera.forward));
  return vec4f(view.x / (camera.tanHalfFov * camera.aspect), view.y / camera.tanHalfFov, TERRAIN_NEAR, view.z);
}

/** Depth only: the draw masks every color channel, scene.wgsl does the shading. */
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.0); }
