// Procedural ridged heightfield in kilometres: a flat valley around the camera, mountains from ~6 km out.

export const TERRAIN_MAX_DISTANCE: f32 = 90.0;
export const TERRAIN_MAX_HEIGHT: f32 = 3.2;
/** The baked heightmap covers a square of this many km centred on the camera origin. */
export const TERRAIN_MAP_EXTENT: f32 = 200.0;
export const TERRAIN_MAP_SIZE: f32 = 2048.0;
/** Ring grid of the terrain mesh (terrain-mesh.wgsl): azimuth columns around the camera axis and rings per column. */
export const TERRAIN_MESH_COLUMNS: u32 = 4096u;
export const TERRAIN_MESH_RINGS: u32 = 512u;
/** Near plane (km) of the terrain depth prepass: reversed-Z, depth = TERRAIN_NEAR / view depth. */
export const TERRAIN_NEAR: f32 = 0.001;

const TAU: f32 = 6.28318530717959;
/** Ring layout: fine geometric steps over the flat valley, 265 m steps across the mountains (heightmap texels are 98 m), coarse steps over the bare sphere. */
const NEAR_RINGS: u32 = 128u;
const MID_RINGS: u32 = 320u;
const NEAR_RADIUS: f32 = 0.005;
const MID_RADIUS: f32 = 5.0;
const FAR_RADIUS: f32 = 90.0;
const LAST_RADIUS: f32 = 400.0;

fn ringRadius(ring: u32) -> f32 {
  if (ring == 0u) { return 0.0; }
  if (ring <= NEAR_RINGS) { return NEAR_RADIUS * pow(MID_RADIUS / NEAR_RADIUS, f32(ring - 1u) / f32(NEAR_RINGS - 1u)); }
  if (ring <= NEAR_RINGS + MID_RINGS) { return MID_RADIUS + (FAR_RADIUS - MID_RADIUS) * f32(ring - NEAR_RINGS) / f32(MID_RINGS); }
  return FAR_RADIUS * pow(LAST_RADIUS / FAR_RADIUS, f32(ring - NEAR_RINGS - MID_RINGS) / f32(TERRAIN_MESH_RINGS - NEAR_RINGS - MID_RINGS));
}

/**
 * A vertex of the terrain ring grid, relative to the ground point under the camera axis (0, groundRadius, 0).
 * The grid is a static set of rings around that axis: one triangle strip per azimuth column (`instanceIndex` plus
 * `columnOffset`), `TERRAIN_MESH_RINGS + 1` ring vertices on each side, no vertex buffers. Heights come from the
 * baked heightmap, and the surface sits at altitude h over the sphere: y = sqrt((R + h)^2 - r^2), formed here
 * without subtracting two 6360 km numbers, which f32 could not afford. Azimuth 0 is +Z, like the camera yaw.
 */
export fn terrainMeshVertex(vertexIndex: u32, instanceIndex: u32, columnOffset: u32, groundRadius: f32, map: texture_2d<f32>, mapSampler: sampler) -> vec3f {
  let ring = vertexIndex / 2u;
  let column = (columnOffset + instanceIndex + (vertexIndex & 1u)) % TERRAIN_MESH_COLUMNS;
  let theta = f32(column) * (TAU / f32(TERRAIN_MESH_COLUMNS));
  let radius = ringRadius(ring);
  let xz = vec2f(sin(theta), cos(theta)) * radius;
  let height = sampleTerrainHeight(map, mapSampler, xz);
  let surfaceRadius = groundRadius + height;
  let rr = dot(xz, xz);
  let y = sqrt(max(surfaceRadius * surfaceRadius - rr, 0.0));
  let relativeY = (height * (2.0 * groundRadius + height) - rr) / (y + groundRadius);
  return vec3f(xz.x, relativeY, xz.y);
}
const TERRAIN_SCALE: f32 = 1.0 / 16.0;
const OCTAVES: i32 = 6;
const ROTATE = mat2x2f(vec2f(0.8, 0.6), vec2f(-0.6, 0.8));

/**
 * Uniform [0, 1) value per lattice cell from an integer hash (pcg2d). The usual fract(sin(h) * 43758.5)
 * hash takes the sine of arguments in the thousands, which every GPU rounds differently, so the same
 * terrain came out with different mountains on Metal and on Mesa; integer arithmetic is exact everywhere.
 */
/** Offsets the lattice hash; picks which of the equally random landscapes the camera stands in. */
const TERRAIN_SEED: u32 = 7u;

fn hash2(p: vec2f) -> f32 {
  var v = (bitcast<vec2u>(vec2i(p)) + vec2u(TERRAIN_SEED, 0u)) * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> vec2u(16u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> vec2u(16u);
  return f32((v.x ^ v.y) >> 8u) / 16777216.0;
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

/** Height above sea level (km) at a tangent-plane position (km). */
export fn terrainHeight(xz: vec2f) -> f32 {
  var p = xz * TERRAIN_SCALE;
  var amplitude = 1.0;
  var height = 0.0;
  var weight = 1.0;
  for (var i = 0; i < OCTAVES; i += 1) {
    let n = 1.0 - abs(valueNoise(p));
    height += n * n * amplitude * weight;
    weight = clamp(n * 1.2, 0.0, 1.0);
    p = ROTATE * p * 2.05 + vec2f(1.7, 9.2);
    amplitude *= 0.5;
  }
  let distance = length(xz);
  // Flat ground under the camera, foothills from ~1 km, full mountains beyond ~6 km, fading out before the march limit.
  let valley = smoothstep(1.0, 6.0, distance);
  let horizonFade = 1.0 - smoothstep(TERRAIN_MAX_DISTANCE * 0.7, TERRAIN_MAX_DISTANCE, distance);
  let rolling = 0.02 * (valueNoise(xz * 0.9) + 0.5 * valueNoise(xz * 2.3 + 4.0)) * smoothstep(0.1, 1.0, distance);
  let mountains = max(0.0, height - 0.55) * 2.6;
  return max(0.0, (mountains * valley + rolling) * horizonFade);
}

fn terrainMapUv(xz: vec2f) -> vec2f { return xz / TERRAIN_MAP_EXTENT + 0.5; }

/** Height (km) from the baked map; bilinear, clamped to the map edge where the terrain has already faded out. */
export fn sampleTerrainHeight(map: texture_2d<f32>, mapSampler: sampler, xz: vec2f) -> f32 {
  return textureSampleLevel(map, mapSampler, terrainMapUv(xz), 0.0).r;
}

export fn sampleTerrainNormal(map: texture_2d<f32>, mapSampler: sampler, xz: vec2f) -> vec3f {
  return normalize(textureSampleLevel(map, mapSampler, terrainMapUv(xz), 0.0).gba);
}

export fn terrainNormal(xz: vec2f, epsilon: f32) -> vec3f {
  let dx = terrainHeight(xz + vec2f(epsilon, 0.0)) - terrainHeight(xz - vec2f(epsilon, 0.0));
  let dz = terrainHeight(xz + vec2f(0.0, epsilon)) - terrainHeight(xz - vec2f(0.0, epsilon));
  return normalize(vec3f(-dx, 2.0 * epsilon, -dz));
}

/** The two low-frequency noises the albedo uses, in [0, 1]; baked into the albedo map by terrain-heightmap.wgsl. */
export fn terrainAlbedoNoise(xz: vec2f) -> vec2f {
  return vec2f(0.5 + 0.5 * valueNoise(xz * 0.35), 0.5 + 0.5 * valueNoise(xz * 0.2));
}

export fn sampleTerrainAlbedoNoise(map: texture_2d<f32>, mapSampler: sampler, xz: vec2f) -> vec2f {
  return textureSampleLevel(map, mapSampler, terrainMapUv(xz), 0.0).rg;
}

/** Albedo by altitude and slope: grass in the plains, rock on steep faces, snow near the peaks. `noise` comes from terrainAlbedoNoise. */
export fn terrainAlbedo(height: f32, normal: vec3f, noise: vec2f) -> vec3f {
  let grass = vec3f(0.11, 0.13, 0.05);
  let dry = vec3f(0.22, 0.17, 0.10);
  let rock = vec3f(0.23, 0.21, 0.19);
  let snow = vec3f(0.78, 0.80, 0.84);
  var albedo = mix(grass, dry, noise.x);
  let slope = 1.0 - normal.y;
  albedo = mix(albedo, rock, smoothstep(0.08, 0.35, slope));
  let snowLine = 1.9 + 0.35 * (noise.y * 2.0 - 1.0);
  let snowAmount = smoothstep(snowLine, snowLine + 0.5, height) * (1.0 - smoothstep(0.35, 0.6, slope));
  return mix(albedo, snow, snowAmount);
}
