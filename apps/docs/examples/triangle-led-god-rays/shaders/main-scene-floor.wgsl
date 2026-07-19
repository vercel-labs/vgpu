// Main scene floor pass: builds the linear-HDR scene from radiance, light-source/SDF input, and floor noise.
import { col3, col3v, oklab_to_rgb, value_remap_clamp } from "./color-utils.wgsl";
import { sdf_triangle_vertices } from "./geometry.wgsl";

struct Config { screen: vec4f, light_sources: vec4f, tunables: vec4f, triangle: vec4f, culling: vec4f, radiance_fit: vec4f };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var radiance_tex: texture_2d<f32>;
@group(0) @binding(2) var light_sources_tex: texture_2d<f32>;
@group(0) @binding(3) var linear_samp: sampler;
@group(0) @binding(4) var floor_noise_tex: texture_2d<f32>;

struct VSOut { @builtin(position) pos: vec4f };
const FLOOR_NOISE_SIZE: i32 = 500;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  return out;
}

fn wrapNoiseCoord(v: i32) -> i32 {
  return ((v % FLOOR_NOISE_SIZE) + FLOOR_NOISE_SIZE) % FLOOR_NOISE_SIZE;
}

fn bg(p: vec2f) -> vec3f {
  let noise_px = vec2i(floor(p));
  let noise_uv = vec2i(wrapNoiseCoord(noise_px.x), wrapNoiseCoord(noise_px.y));
  let floor_noise = textureLoad(floor_noise_tex, noise_uv, 0).r;
  let floor_brightness = mix(cfg.tunables.y, cfg.tunables.y * 0.7, floor_noise);
  return col3(floor_brightness);
}

fn distance_to_aabb(p: vec2f, box_min: vec2f, box_max: vec2f) -> f32 {
  let d = max(max(box_min - p, p - box_max), vec2f(0.0));
  return length(d);
}

fn light_bg(triangle_sdf: f32) -> vec3f {
  let outside_distance = max(triangle_sdf, 0.0);
  let ao_radius = cfg.triangle.z * cfg.culling.w;
  let contact_ao = (1.0 - smoothstep(0.0, ao_radius, outside_distance)) * cfg.screen.w;
  return vec3f(1.0 - contact_ao);
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let uv = in.pos.xy / cfg.screen.xy;
  let pixel_screen = in.pos.xy;
  let top = vec2f(cfg.triangle.x, cfg.triangle.y - cfg.triangle.z);
  let left = vec2f(cfg.triangle.x - cfg.triangle.w, cfg.triangle.y + cfg.triangle.z * 0.5);
  let right = vec2f(cfg.triangle.x + cfg.triangle.w, cfg.triangle.y + cfg.triangle.z * 0.5);
  let triangle_sdf = sdf_triangle_vertices(pixel_screen, top, left, right);
  let light_sources_px = clamp(vec2i(floor(uv * cfg.light_sources.xy)), vec2i(0), vec2i(cfg.light_sources.xy) - vec2i(1));
  let light_sources = textureLoad(light_sources_tex, light_sources_px, 0);
  let pixel = uv * cfg.screen.xy - cfg.screen.xy * 0.5;
  let fitted_uv = (pixel_screen - cfg.radiance_fit.xy) / cfg.radiance_fit.zw;
  let inside_fit =
    fitted_uv.x >= 0.0 && fitted_uv.x <= 1.0 &&
    fitted_uv.y >= 0.0 && fitted_uv.y <= 1.0;
  var radiance = textureSample(radiance_tex, linear_samp, clamp(fitted_uv, vec2f(0.0), vec2f(1.0))).rgb;
  if (!inside_fit) {
    radiance = vec3f(0.0);
  }
  let light_min = vec2f(left.x - cfg.culling.x, top.y - cfg.culling.y);
  let light_max = vec2f(right.x + cfg.culling.x, left.y + cfg.culling.y);
  let light_aabb_size = light_max - light_min;
  let discard_margin_px = cfg.culling.z * 1.5 * max(light_aabb_size.x, light_aabb_size.y);
  if (distance_to_aabb(pixel_screen, light_min, light_max) > discard_margin_px) {
    radiance = vec3f(0.0);
  }
  let surface = smoothstep(1.0, 0.0, light_sources.w);
  if (cfg.screen.z > 0.5) {
    var floor_colour = light_bg(triangle_sdf);
    floor_colour = mix(floor_colour, light_sources.rgb, surface);
    var colour = floor_colour;
    colour += radiance * (cfg.tunables.y * 4.0);
    colour = mix(colour, max(colour, light_sources.rgb), surface);
    return vec4f(colour, 1.0);
  }

  var colour = mix(bg(pixel), col3v(light_sources.rgb), surface);
  colour = oklab_to_rgb(colour);
  colour *= radiance;
  colour = mix(colour, light_sources.rgb, surface);
  let brightness_factor = pow(value_remap_clamp(triangle_sdf, cfg.triangle.z * 1.7, 0.0, 0.0, 1.0), 2.2);
  colour *= brightness_factor;
  return vec4f(colour, 1.0);
}
