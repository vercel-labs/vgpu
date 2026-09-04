import { Atmosphere, SunShadow } from "./atmosphere-common.wgsl";
import { CLOUD_SHADOW_MAP_SIZE, Clouds, cloudDensity } from "./clouds-common.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> clouds: Clouds;
@group(0) @binding(2) var shapeNoise: texture_3d<f32>;
@group(0) @binding(3) var detailNoise: texture_3d<f32>;
@group(0) @binding(4) var weatherMap: texture_2d<f32>;
@group(0) @binding(5) var curlNoise: texture_2d<f32>;
@group(0) @binding(6) var noiseSampler: sampler;
@group(0) @binding(7) var cloudShadowMap: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var<uniform> sunShadow: SunShadow;

/** Samples through the cloud layer along the sun; the map's texels are coarser than this anyway. */
const SAMPLES: i32 = 8;
/** Extinction per unit density, 1/km; the same value the cloud march uses. */
const EXTINCTION: f32 = 32.0;

/** Both intersections with a sphere at the origin along an infinite line: (near, far), or (-1, -1) when missed. */
fn lineSphere(origin: vec3f, dir: vec3f, radius: f32) -> vec2f {
  let b = 2.0 * dot(dir, origin);
  let c = dot(origin, origin) - radius * radius;
  let delta = b * b - 4.0 * c;
  if (delta < 0.0) { return vec2f(-1.0); }
  let root = sqrt(delta);
  return vec2f((-b - root) * 0.5, (-b + root) * 0.5);
}

/**
 * Cloud shadow as a map in the sun's frame: each texel is one light ray of the far shadow cascade, and stores the
 * transmittance of the cloud layer along it. Anything below the layer on that ray, terrain or air at any altitude,
 * reads the same value with a projection through the cascade's matrix, which is exactly the shadow it receives.
 * Rebuilt every frame: the wind moves the clouds and the sun may move too; eight cheap density samples per texel.
 */
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = atmosphere;
  var transmittance = 1.0;
  if (p.sunDirection.y > 0.02 && clouds.coverage > 0.0) {
    // The ray of this texel: any point of it back in world space (relative to the ground point, then planet-centric).
    let clip = (vec2f(id.xy) + 0.5) / CLOUD_SHADOW_MAP_SIZE * 2.0 - 1.0;
    let onRay = (sunShadow.fromShadow2 * vec4f(clip.x, -clip.y, 0.0, 1.0)).xyz + vec3f(0.0, p.groundRadius, 0.0);
    // The layer along the line toward the sun: from where the line leaves the bottom sphere (or enters the top one when
    // it misses the bottom) to where it leaves the top sphere.
    let top = lineSphere(onRay, p.sunDirection, p.groundRadius + clouds.top);
    let bottom = lineSphere(onRay, p.sunDirection, p.groundRadius + clouds.bottom);
    if (top.y > top.x) {
      let start = select(top.x, bottom.y, bottom.y > bottom.x);
      let end = top.y;
      if (end > start) {
        let step = (end - start) / f32(SAMPLES);
        var opticalDepth = 0.0;
        for (var i = 0; i < SAMPLES; i += 1) {
          let position = onRay + p.sunDirection * (start + (f32(i) + 0.5) * step);
          let altitude = length(position) - p.groundRadius;
          opticalDepth += cloudDensity(clouds, shapeNoise, detailNoise, weatherMap, curlNoise, noiseSampler, position, altitude, 1e9, true) * step;
        }
        transmittance = exp(-EXTINCTION * opticalDepth);
      }
    }
  }
  textureStore(cloudShadowMap, id.xy, vec4f(transmittance, 0.0, 0.0, 1.0));
}
