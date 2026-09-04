import { Atmosphere, SunShadow, sunShadowMatrix } from "./atmosphere-common.wgsl";
import { terrainMeshVertex } from "./terrain.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> mesh: TerrainMesh;
@group(0) @binding(2) var terrainMap: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var<uniform> sunShadow: SunShadow;
@group(0) @binding(5) var<uniform> cascade: Cascade;

struct TerrainMesh { columnOffset: u32, columns: u32 };
/** Which of the three shadow cascades this draw renders. */
struct Cascade { index: u32, pad0: u32, pad1: u32, pad2: u32 };

/**
 * The sun's shadow maps: the whole ring grid rasterized from the sun with the orthographic projection of one cascade
 * (sunShadow in atmosphere-common.wgsl, built in renderer.ts), depth only, nearest occluder wins. Every ring is drawn for
 * every cascade: a far peak shadows the near disc along the light just the same. Rebuilt when the sun moves.
 */
@vertex fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> @builtin(position) vec4f {
  let fromGround = terrainMeshVertex(vertexIndex, instanceIndex, mesh.columnOffset, atmosphere.groundRadius, terrainMap, lutSampler);
  let shadow = sunShadowMatrix(sunShadow, i32(cascade.index)) * vec4f(fromGround, 1.0);
  return vec4f(shadow.xy, shadow.z, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.0); }
