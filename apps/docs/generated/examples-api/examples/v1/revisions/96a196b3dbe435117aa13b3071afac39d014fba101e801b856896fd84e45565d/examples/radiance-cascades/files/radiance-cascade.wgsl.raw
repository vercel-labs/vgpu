import { rc_atlas_decode, rc_atlas_texel, rc_block_size } from "./rc-directions.wgsl";
import { rc_direction, rc_probe_origin, rc_probe_spacing, rc_ray_count } from "./rc-directions.wgsl";
import { sphere_trace } from "./sdf-sample.wgsl";

// One cascade: trace this level's interval for every probe and direction, then merge the
// level above into it. The chain runs top-down (cascade 5 first, cascade 0 last), so by the
// time cascade 0 is written it already carries the whole hierarchy's radiance.
//
// Every texel of the atlas is one (probe, direction) pair; both cascades involved use the
// same atlas dimensions, which is what lets two targets be recycled for six levels.

fn rc_interval_start(cascade: f32) -> f32 {
  return 2.0 * (pow(4.0, cascade) - 1.0) / 3.0;
}

fn rc_interval_length(cascade: f32) -> f32 {
  return 2.0 * pow(4.0, cascade);
}

fn rc_interval_end(cascade: f32) -> f32 {
  return rc_interval_start(cascade) +
    rc_interval_length(cascade) * (1.0 + 0.02);
}

const RC_BRANCH_WEIGHT: f32 = 0.25;

fn rc_merge(near: vec4f, far: vec4f) -> vec4f {
  return vec4f(near.rgb + near.a * far.rgb, near.a * far.a);
}

fn rc_bilinear_weights(fraction: vec2f) -> vec4f {
  let f = clamp(fraction, vec2f(0.0), vec2f(1.0));
  return vec4f(
    (1.0 - f.x) * (1.0 - f.y),
    f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y,
    f.x * f.y,
  );
}

fn rc_clamp_probe(probe: vec2f, grid: vec2f) -> vec2f {
  return clamp(probe, vec2f(0.0), grid - vec2f(1.0));
}

struct Cascade {
  /** x: level index, y: whether an upper cascade exists. */
  state: vec4f,
};

@group(0) @binding(0) var<uniform> rc: Cascade;
@group(0) @binding(1) var sdf_tex: texture_2d<f32>;
@group(0) @binding(2) var sdf_samp: sampler;
@group(0) @binding(3) var emitter_tex: texture_2d<f32>;
@group(0) @binding(4) var emitter_samp: sampler;
@group(0) @binding(5) var upper_tex: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let atlas_size = vec2f(textureDimensions(upper_tex));
  let scene_size = vec2f(textureDimensions(sdf_tex));
  let cascade = rc.state.x;
  let texel = floor(uv * atlas_size);
  let block = rc_block_size(cascade);
  let rays = rc_ray_count(cascade);
  let decoded = rc_atlas_decode(texel, block);
  let probe = decoded.xy;
  let direction_index = decoded.z;

  let spacing = rc_probe_spacing(cascade);
  let origin = rc_probe_origin(probe, spacing);
  let direction = rc_direction(direction_index, rays);

  var radiance = sphere_trace(
    sdf_tex,
    sdf_samp,
    emitter_tex,
    emitter_samp,
    scene_size,
    origin,
    direction,
    rc_interval_start(cascade),
    rc_interval_end(cascade),
  );

  if (rc.state.y > 0.5) {
    let upper_block = block * 2.0;
    let upper_spacing = spacing * 2.0;
    let upper_grid = atlas_size / upper_block;

    // Where this probe sits in the upper cascade's probe grid. The -0.5 turns probe
    // centres into a lattice the bilinear weights can interpolate between.
    let position = origin / upper_spacing - 0.5;
    let base = floor(position);
    let weights = rc_bilinear_weights(position - base);
    var weight_array = array<f32, 4>(
      weights.x,
      weights.y,
      weights.z,
      weights.w,
    );

    var far = vec4f(0.0);
    for (var branch = 0; branch < 4; branch = branch + 1) {
      // The four directions of the upper cascade that subdivide this one. Their angles
      // straddle the parent's: (i+0.125, i+0.375, i+0.625, i+0.875) / rays.
      let upper_direction = direction_index * 4.0 + f32(branch);
      var interpolated = vec4f(0.0);
      for (var corner = 0; corner < 4; corner = corner + 1) {
        let offset = vec2f(f32(corner % 2), f32(corner / 2));
        // Clamp in probe space: the atlas interleaves directions, so a texel-space clamp
        // would fetch a different direction of the opposite edge and leak light.
        let neighbour = rc_clamp_probe(base + offset, upper_grid);
        let coord = rc_atlas_texel(neighbour, upper_direction, upper_block);
        interpolated +=
          weight_array[corner] * textureLoad(upper_tex, vec2i(coord), 0);
      }
      // Merge-then-average: each child direction is merged as a whole ray, and only the
      // four results are averaged, so occlusion survives instead of being pre-blurred.
      far += interpolated * RC_BRANCH_WEIGHT;
    }
    radiance = rc_merge(radiance, far);
  }

  return radiance;
}
