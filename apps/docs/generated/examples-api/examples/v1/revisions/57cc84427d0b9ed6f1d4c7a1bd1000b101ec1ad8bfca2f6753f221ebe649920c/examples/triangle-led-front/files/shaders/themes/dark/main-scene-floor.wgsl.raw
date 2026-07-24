// Dark theme floor material: builds the scene from radiance, light-source/SDF input, and floor
// noise, then tonemaps + applies display contrast inline so it renders straight to the canvas
// (no separate composite pass in dark mode).
import { col3v, oklab_to_rgb, tonemap, value_remap_clamp } from "../../color-utils.wgsl";
import { sdf_triangle_vertices } from "../../geometry.wgsl";
import { near_falloff, middle_falloff, far_falloff } from "../../floor-falloff.wgsl";

struct Config { screen: vec4f, light_sources: vec4f, tunables: vec4f, triangle: vec4f, culling: vec4f, radiance_fit: vec4f, light_ao: vec4f, radiance_debug: vec4f, sim_transform: vec4f, dark_floor: vec4f, dark_glow: vec4f, dark_near: vec4f, dark_middle: vec4f, dark_toggles: vec4f, dark_circle: vec4f, dark_noise: vec4f };
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

// Grain density in texels per CSS pixel. Anchoring to CSS px (not the device-pixel backing
// store) keeps the grain the SAME visual size at any DPR. 2 ≈ the DPR-2/retina look, so
// DPR-2 is unchanged and DPR-1 (which used to read 1 texel/CSS px → coarse) is brought in line.
const FLOOR_NOISE_DENSITY: f32 = 2.0;

// At DPR 1 the tiling floor grain reads as a coarse, visibly-repeating PATTERN, so scale its
// intensity down to this fraction there; DPR>1 (retina) keeps the full grain (1.0). cfg.screen.w = DPR.
const DARK_FLOOR_GRAIN_DPR1_SCALE: f32 = 0.5;

// Reads the tiling floor noise (r channel, [0,1]) at a DPR-independent position. `p` is in
// device px; cfg.screen.w is the real device pixel ratio (DPR), so p / dpr is CSS px → the
// grain no longer scales with the backing-store resolution. (DPR — not sim_transform.z,
// which is the sim→device fit scale and only equals DPR when the sim isn't floored.)
fn sample_floor_noise(p: vec2f) -> f32 {
  let css_px = p / max(cfg.screen.w, 1e-4);
  let noise_px = vec2i(floor(css_px * FLOOR_NOISE_DENSITY));
  let noise_uv = vec2i(wrapNoiseCoord(noise_px.x), wrapNoiseCoord(noise_px.y));
  return textureLoad(floor_noise_tex, noise_uv, 0).r;
}

// Cheap per-pixel hash (Dave Hoskins, hash12) → [0,1]; picks the jitter angle.
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Sibling of hash12 with a different seed multiplier — same character, independent
// values. Used for the radiance multisample blend weight so it is decorrelated from
// both the jitter angle (hash12) and the floor-brightness grain (sample_floor_noise).
fn hash12b(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1531);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn bg(p: vec2f) -> vec3f {
  // dark_noise.x gates the floor-noise lightness modulation. Off (static bake) →
  // flat albedo, so the baked glow stays smooth and the grain is reintroduced as a
  // CSS noise overlay instead.
  let floor_noise = sample_floor_noise(p) * cfg.dark_noise.x;
  // Lower the grain intensity at DPR 1 (where its tiling repeat is a visible pattern); full at DPR>1.
  let grain_intensity = select(1.0, DARK_FLOOR_GRAIN_DPR1_SCALE, cfg.screen.w < 1.5);
  let floor_brightness =
    mix(cfg.tunables.y, cfg.tunables.y * 0.5, floor_noise * grain_intensity);
  // Return the floor base in RGB (gray). The oklab perceptual lift now happens only where an
  // LED color actually blends in (surface > 0, see fs_main), so floor pixels skip rgb<->oklab.
  return vec3f(floor_brightness);
}

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

struct TriangleCorners { top: vec2f, left: vec2f, right: vec2f };

fn triangle_corners() -> TriangleCorners {
  let top = vec2f(cfg.triangle.x, cfg.triangle.y - cfg.triangle.z);
  let left = vec2f(cfg.triangle.x - cfg.triangle.w, cfg.triangle.y + cfg.triangle.z * 0.5);
  let right = vec2f(cfg.triangle.x + cfg.triangle.w, cfg.triangle.y + cfg.triangle.z * 0.5);
  return TriangleCorners(top, left, right);
}

// Reads the LED emitter/SDF texture in simulation space, blanking samples that
// fall outside the simulation rect.
fn sample_light_sources(pixel_screen: vec2f) -> vec4f {
  let sim_px = (pixel_screen - cfg.sim_transform.xy) / cfg.sim_transform.z;
  let px = clamp(vec2i(floor(sim_px)), vec2i(0), vec2i(cfg.light_sources.xy) - vec2i(1));
  let inside_sim =
    sim_px.x >= 0.0 && sim_px.x < cfg.light_sources.x &&
    sim_px.y >= 0.0 && sim_px.y < cfg.light_sources.y;
  var light_sources = textureLoad(light_sources_tex, px, 0);
  if (!inside_sim) {
    light_sources = vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return light_sources;
}

// Mitchell-Netravali / BC-spline cubic weight. (B, C) selects the filter and trades
// sharpness for smoothing — the lever for the visible half-res jitter texture:
//   B=0,   C=0.5  → Catmull-Rom    (sharp, negative lobes; the previous kernel — preserves noise)
//   B=1/3, C=1/3  → Mitchell       (balanced low-pass; softens the jitter grain, default)
//   B=1,   C=0    → cubic B-spline (max smoothing/blur, softest)
const UPSAMPLE_B: f32 = 1;
const UPSAMPLE_C: f32 = 0.;

fn bc_spline_weight(x: f32) -> f32 {
  let ax = abs(x);
  let b = UPSAMPLE_B;
  let c = UPSAMPLE_C;
  if (ax < 1.0) {
    return ((12.0 - 9.0 * b - 6.0 * c) * ax * ax * ax
      + (-18.0 + 12.0 * b + 6.0 * c) * ax * ax
      + (6.0 - 2.0 * b)) / 6.0;
  }
  if (ax < 2.0) {
    return ((-b - 6.0 * c) * ax * ax * ax
      + (6.0 * b + 30.0 * c) * ax * ax
      + (-12.0 * b - 48.0 * c) * ax
      + (8.0 * b + 24.0 * c)) / 6.0;
  }
  return 0.0;
}

// BC-spline (Mitchell-Netravali) 4x4 sampling for the half-resolution direct radiance
// target. Taps are clamped in texel space so edge pixels do not smear wrapped values.
fn sample_radiance_cubic(uv: vec2f) -> vec3f {
  let dims_u = textureDimensions(radiance_tex);
  let dims = vec2f(dims_u);
  let texel = clamp(uv, vec2f(0.0), vec2f(1.0)) * dims - vec2f(0.5);
  let base = floor(texel);
  let f = texel - base;
  var sum = vec3f(0.0);
  var weight_sum = 0.0;
  for (var y: i32 = -1; y <= 2; y = y + 1) {
    let wy = bc_spline_weight(f.y - f32(y));
    for (var x: i32 = -1; x <= 2; x = x + 1) {
      let wx = bc_spline_weight(f.x - f32(x));
      let w = wx * wy;
      let tap = clamp(vec2i(base) + vec2i(x, y), vec2i(0), vec2i(dims_u) - vec2i(1));
      sum += textureLoad(radiance_tex, tap, 0).rgb * w;
      weight_sum += w;
    }
  }
  return max(sum / max(weight_sum, 1e-5), vec3f(0.0));
}

// Samples the fitted radiance texture, blanking samples outside the fit rect.
fn sample_radiance_at(pixel_screen: vec2f) -> vec3f {
  let fitted_uv = (pixel_screen - cfg.radiance_fit.xy) / cfg.radiance_fit.zw;
  let inside_fit =
    fitted_uv.x >= 0.0 && fitted_uv.x <= 1.0 &&
    fitted_uv.y >= 0.0 && fitted_uv.y <= 1.0;
  var radiance = sample_radiance_cubic(fitted_uv);
  if (!inside_fit) {
    radiance = vec3f(0.0);
  }
  return radiance;
}

// Noise-driven jittered multisample of the radiance, to dither away the blocky
// artifacts of the low-quality (perf-optimized) radiance cascades. The jitter
// distance grows where the light is dim — bright lit areas stay sharp while the
// faint falloff regions (where the artifacts show) get a wider offset — and a
// hash noise (hash12b) sets the blend weight of the offset sample, decorrelated from
// the floor-brightness grain. A second sample is pulled from a hashed random
// direction. dark_middle.z = max jitter distance in screen px (0 disables).
fn sample_radiance(pixel_screen: vec2f, triangle_sdf: f32) -> vec3f {
  let base = sample_radiance_at(pixel_screen);
  // dark_noise.x off (static bake) → a single radiance sample, no noise-driven
  // jitter dither. The bake renders at high probe density so there are no low-res
  // cascade artifacts to hide, and the grain comes from the CSS noise overlay.
  if (cfg.dark_noise.x < 0.5) {
    return base;
  }
  // Bigger offset the dimmer the light: intensity 0 → 1, intensity >= 0.5 → 0.
  let light_intensity = dot(base, LUMA);
  var offset_scale = value_remap_clamp(light_intensity, 0.2, 0.1, 0.0, 1.0);
  // Keep the sharp light line at the triangle edge crisp: kill the offset right at
  // the edge (sdf 0) and ramp it quickly to full over a thin band just outside.
  offset_scale *= value_remap_clamp(triangle_sdf, 0.0, cfg.triangle.z * 0.9, 0.0, 1.0);

  // Bright pixels (light_intensity >= 0.2) and the triangle edge clamp offset_scale to exactly
  // 0, so the offset is zero and the jittered sample would read the same texel as `base`
  // (mix(base, base, noise) == base to within a ULP). Skip the second 16-tap cubic fetch there
  // — that's the whole bright glow region of this full-canvas pass.
  if (offset_scale <= 0.0) {
    return base;
  }

  let noise = hash12b(pixel_screen);
  let angle = hash12(pixel_screen) * 6.2831853;
  let dir = vec2f(cos(angle), sin(angle));
  // dark_middle.w normalizes the screen-px offset (dark_middle.z) to a constant FRACTION of
  // the on-screen scene height (presentation height / desktop-cap reference, clamped <= 1).
  // A fixed px offset is a larger fraction of a short canvas, over-blending spatially-separated
  // (different-hued) radiance → desaturation; this scales it down proportionally. 1 at the
  // desktop cap, so that render is byte-identical.
  let offset = dir * offset_scale * cfg.dark_middle.z * cfg.dark_middle.w;
  let jittered = sample_radiance_at(pixel_screen + offset);
  return mix(base, jittered, noise);
}

// Combines the floor base colour with radiance, the LED surface, vibrancy
// saturation, and the falloff envelope into the final linear-HDR colour.
fn compose_floor(
  base_colour: vec3f,
  radiance: vec3f,
  light_sources: vec4f,
  surface: f32,
  brightness_factor: f32,
) -> vec3f {
  var colour = max(base_colour, vec3f(0.0));
  colour *= radiance;
  colour = mix(colour, light_sources.rgb, surface);
  let sat = 1.0 + (cfg.dark_glow.y - 1.0) * brightness_factor;
  let luma = dot(colour, LUMA);
  colour = max(mix(vec3f(luma), colour, sat), vec3f(0.0));
  colour *= brightness_factor;
  return colour;
}

// On the mobile layout the canvas is a SQUARE (≈1:1) rather than the desktop 3:2 rect, and the
// top/bottom fade band reads as too small there — so widen it by this factor on mobile. Mobile is
// detected from the canvas aspect (width < ~1.25 × height ⇒ the square mobile box), so no extra
// uniform is needed. Tune this for the mobile fade size.
const DARK_EDGE_FADE_MOBILE_BOOST: f32 = 2.0;

// VERTICAL-ONLY screen-edge envelope: 1 across the interior, easing to 0 only near the TOP and
// BOTTOM edges — never left/right (the glow should never fade on the X axis). The easing is t² (not
// smoothstep): soft/gentle near the edge (the fade lifts slowly off 0) and steepening to an abrupt
// arrival at full toward the interior. The band height is `dark_circle.x` (0.1 on mobile, 0.2 on
// desktop; resolved at init, see getHeroEdgeFadeFrac) as a fraction of the canvas HEIGHT, widened
// on the square mobile canvas by DARK_EDGE_FADE_MOBILE_BOOST.
fn edge_fade(pixel_screen: vec2f) -> f32 {
  let mobile_boost =
    select(1.0, DARK_EDGE_FADE_MOBILE_BOOST, cfg.screen.x < cfg.screen.y * 1.25);
  let w = max(cfg.dark_circle.x * mobile_boost * cfg.screen.y, 1.0);
  let d = min(pixel_screen.y, cfg.screen.y - pixel_screen.y);
  let t = clamp(d / w, 0.0, 1.0);
  return sqrt(t);
}

// Pixels deep inside the occluder triangle are painted pure black by the occluder (and the edge
// fade can only darken further), so the whole floor body there — incl. the 16-tap radiance
// fetch — is wasted. This margin keeps the ~1px anti-aliased silhouette on the full path.
const OCCLUDER_INTERIOR_MARGIN: f32 = 4.0;

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let pixel_screen = in.pos.xy;
  let uv = pixel_screen / cfg.screen.xy;
  let pixel = uv * cfg.screen.xy - cfg.screen.xy * 0.5;
  let tri = triangle_corners();
  let triangle_sdf = sdf_triangle_vertices(pixel_screen, tri.top, tri.left, tri.right);
  // The SDF screen-space gradient is a derivative: it must run in uniform control flow, so compute
  // the occluder edge width here (before the per-pixel early-out below) and reuse it for the
  // silhouette later. length(dpdx, dpdy) is the true gradient magnitude; fwidth's Manhattan sum
  // |dpdx|+|dpdy| overestimates it by up to sqrt(2) on diagonal edges, over-blurring them.
  let occluder_edge = max(length(vec2f(dpdx(triangle_sdf), dpdy(triangle_sdf))), 1e-4);
  // Early-out to the exact interior value when the occluder is on and we are not in radiance-debug.
  // Uniform-gated, so wavefronts deep inside the triangle skip the body coherently.
  if (cfg.culling.z > 0.5 && cfg.radiance_debug.x <= 0.5 && triangle_sdf < -OCCLUDER_INTERIOR_MARGIN) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let light_sources = sample_light_sources(pixel_screen);
  let radiance = sample_radiance(pixel_screen, triangle_sdf);
  if (cfg.radiance_debug.x > 0.5) {
    return vec4f(clamp(radiance * cfg.radiance_debug.yzw, vec3f(0.0), vec3f(1.0)), 1.0);
  }

  // LED surface mask, derived from the emitter color itself (light_sources.rgb) instead of
  // the baked SDF (.w): 1 exactly where an LED is lit, 0 in the gaps / floor. It can't
  // disagree with the rgb the way the .w mask did (that mismatch — .w extending past the
  // rgb's triangle clip — was the black band), and it keeps the discrete LEDs. The
  // geometric occluder (drawn below) hides the inside, so only the edge strip shows.
  let surface = smoothstep(
    4.0,
    4.02,
    max(max(light_sources.r, light_sources.g), light_sources.b),
  );
  // Floor base in RGB; blend toward the LED color (in cbrt-LMS space) only where an LED is
  // present (surface > 0). Floor pixels skip both rgb_to_oklab calls + the oklab_to_rgb round-trip.
  let floor_rgb = bg(pixel);
  var base_rgb = floor_rgb;
  if (surface > 0.0) {
    base_rgb = oklab_to_rgb(mix(col3v(floor_rgb), col3v(light_sources.rgb), surface));
  }

  // Three glow layers, brightest first. See the *_falloff helpers. Screen-blend
  // the in-range [0,1] parts (preserves the tuned look), then add any over-1
  // overflow additively. A plain screen blend on HDR layers is non-monotonic:
  // once two layers exceed 1, their (1 - x) terms both go negative, the product
  // flips positive, and brightness_factor collapses through 0 to negative — which
  // tonemaps to black. Splitting off the overflow keeps it monotonic so high
  // intensities keep getting brighter and the tonemap saturates them to white.
  let fade_inner = cfg.dark_floor.y;
  let near_light = dot(radiance, LUMA);
  let near = near_falloff(
    triangle_sdf,
    near_light,
    fade_inner,
    cfg.triangle.z,
    cfg.dark_near,
    cfg.dark_floor.z,
    cfg.dark_toggles.x,
  );
  // middle_falloff returns 0 when its toggle (dark_toggles.y) is off — the shipping default — so
  // skip the whole remap+pow+smoothstep there. Uniform-gated: no divergence.
  var middle = 0.0;
  if (cfg.dark_toggles.y > 0.5) {
    middle = middle_falloff(
      triangle_sdf,
      fade_inner,
      cfg.triangle.z,
      cfg.dark_floor.x,
      cfg.dark_middle,
      cfg.dark_toggles.y,
    );
  }
  let far = far_falloff(
    near_light,
    cfg.dark_glow,
    cfg.dark_floor.w,
    cfg.dark_toggles.z,
  );
  let screen_blend =
    1.0 - (1.0 - min(near, 1.0)) * (1.0 - min(middle, 1.0)) * (1.0 - min(far, 1.0));
  let overflow =
    max(near - 1.0, 0.0) + max(middle - 1.0, 0.0) + max(far - 1.0, 0.0);
  let brightness_factor = screen_blend + overflow;

  var colour = compose_floor(
    base_rgb,
    radiance,
    light_sources,
    surface,
    brightness_factor,
  );

  // Final output (no composite pass in dark mode): tonemap (HDR → sRGB-display,
  // operator chosen by the TONEMAP const in color-utils) → display contrast
  // (dark_toggles.w). Opaque — dark fully owns the frame.
  // dark_circle.y = pre-tonemap exposure (overall HDR gain applied before the tonemap roll-off).
  var final_colour = tonemap(colour * cfg.dark_circle.y);
  final_colour = (final_colour - vec3f(0.5)) * cfg.dark_toggles.w + vec3f(0.5);

  // Foreground triangle occluder, drawn analytically from the same SDF instead of as a separate
  // hard-edged geometry pass. occluder_edge (the SDF gradient length, hoisted above into uniform
  // control flow) gives the screen-space edge width, so the silhouette is anti-aliased to ~1px and stays aligned
  // with the edge light line above. cfg.culling.z is the show-triangle flag (0/1).
  let occluder = clamp(0.5 - triangle_sdf / occluder_edge, 0.0, 1.0) * cfg.culling.z;
  final_colour = mix(final_colour, vec3f(0.0), occluder);

  // Screen-edge fade as a plain multiply by the edge envelope: scales the colour uniformly
  // toward black at the screen edges, so it keeps its hue (a scalar multiply preserves the
  // channel ratios). No per-channel min (which equalized channels → gray) and no luminance
  // division (unstable at low values).
  final_colour = final_colour * edge_fade(pixel_screen);

  return vec4f(final_colour, 1.0);
}
