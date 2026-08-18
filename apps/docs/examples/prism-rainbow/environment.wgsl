// The studio the glass reflects, copied from `vgpu.sh/examples/glass-fractal`.
//
// That example ships its environment as a baked cubemap: nine soft panels and a
// room gradient evaluated per direction by `tools/generate-hero-studio-cubemap.mjs`,
// written to a PNG, uploaded as an `rgba8unorm-srgb` array texture and sampled
// through a direction-to-face lookup. The panels, the room, the horizon glow and
// the filmic compression below are that generator, function for function; only the
// last mile changed, because this example has no asset pipeline to load one
// through: its thumbnail and its GPU tests both render in headless Node, where
// there is no `fetch` and no `createImageBitmap`. Evaluating the same function in
// WGSL keeps the reflections identical and the example self-contained.
//
// The final line replays the round trip the asset used to perform — encode to
// gamma 2.2, decode as sRGB — so the values a reflection reads here are the values
// a reflection reads there, including the small mismatch between those two curves.
//
// Sampling analytically also costs nothing in fidelity for this material: the
// baked cubemap carries a prefiltered mip chain for rough surfaces, and glass
// only ever reads its sharpest level.

import { srgbToLinear3 } from "@vgpu/wgsl-std/color";

struct StudioPanel {
  direction: vec3f,
  /** Half-extents of the panel in tangent space, as a fraction of its distance. */
  size: vec2f,
  feather: f32,
  color: vec3f,
  intensity: f32,
}

/** Copied from `glass-fractal`; the numbers are the studio's whole lighting rig. */
fn studioPanels() -> array<StudioPanel, 9> {
  return array<StudioPanel, 9>(
    StudioPanel(vec3f(-0.32, 0.91, 0.27), vec2f(0.2, 0.055), 0.018, vec3f(1.0, 0.95, 0.87), 8.5),
    StudioPanel(vec3f(0.08, 0.97, 0.23), vec2f(0.15, 0.045), 0.015, vec3f(1.0, 0.99, 0.96), 9.5),
    StudioPanel(vec3f(0.51, 0.83, 0.23), vec2f(0.18, 0.05), 0.016, vec3f(0.82, 0.91, 1.0), 8.0),
    StudioPanel(vec3f(0.86, 0.43, -0.28), vec2f(0.06, 0.17), 0.018, vec3f(0.74, 0.86, 1.0), 7.25),
    StudioPanel(vec3f(-0.86, 0.43, -0.28), vec2f(0.065, 0.16), 0.018, vec3f(1.0, 0.79, 0.68), 6.75),
    StudioPanel(vec3f(-0.22, 0.81, -0.54), vec2f(0.16, 0.045), 0.014, vec3f(0.96, 0.91, 0.86), 8.0),
    StudioPanel(vec3f(0.26, 0.76, -0.6), vec2f(0.12, 0.04), 0.014, vec3f(0.78, 0.87, 1.0), 7.5),
    StudioPanel(vec3f(0.3, 0.2, 0.93), vec2f(0.18, 0.055), 0.016, vec3f(0.82, 0.91, 1.0), 11.0),
    StudioPanel(vec3f(-0.97, -0.03, -0.23), vec2f(0.15, 0.05), 0.016, vec3f(1.0, 0.86, 0.76), 10.0),
  );
}

/**
 * How much of `panel` a ray heading in `direction` sees: a rectangle projected
 * onto the sphere, feathered at its border so its edge does not alias in a
 * mirror-smooth reflection.
 */
fn studioPanelMask(direction: vec3f, panel: StudioPanel) -> f32 {
  let forward = normalize(panel.direction);
  // Any helper axis works as long as it is not parallel to the panel's own; the
  // overhead panels are the ones that need the fallback.
  let helper = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(forward.y) > 0.92);
  let right = normalize(cross(helper, forward));
  let up = cross(forward, right);
  let facing = dot(direction, forward);
  if (facing <= 0.01) {
    return 0.0;
  }
  let localX = abs(dot(direction, right) / facing);
  let localY = abs(dot(direction, up) / facing);
  let edgeX = 1.0 - smoothstep(panel.size.x, panel.size.x + panel.feather, localX);
  let edgeY = 1.0 - smoothstep(panel.size.y, panel.size.y + panel.feather, localY);
  return edgeX * edgeY;
}

/** Rotates a reflection into the studio's frame. Copied from `glass-fractal`. */
export fn rotateEnvironmentDirection(direction: vec3f, rotation: mat4x4f) -> vec3f {
  return normalize((rotation * vec4f(direction, 0.0)).xyz);
}

/** Radiance arriving from `direction`, in linear RGB. */
export fn sampleStudioEnvironment(directionInput: vec3f) -> vec3f {
  let direction = normalize(directionInput);
  // `smoothstep`'s edges are swapped in the original, which WGSL leaves
  // undefined; `1 - smoothstep(low, high, y)` is the same curve, since
  // 3t^2 - 2t^3 is symmetric about its midpoint.
  let floorBlend = 1.0 - smoothstep(-0.18, 0.08, direction.y);
  let wallWarmth = 0.5 + 0.5 * direction.x;
  let room = mix(
    vec3f(0.055 + wallWarmth * 0.018, 0.065, 0.085 - wallWarmth * 0.012),
    vec3f(0.84, 0.82, 0.77),
    floorBlend,
  );
  let horizon = exp(-abs(direction.y) * 14.0) * 0.12;
  var color = room + vec3f(horizon, horizon * 0.95, horizon * 0.9);
  let panels = studioPanels();
  for (var index = 0u; index < 9u; index = index + 1u) {
    let panel = panels[index];
    color = color + panel.color * (studioPanelMask(direction, panel) * panel.intensity);
  }
  // Filmic compression, then the asset's gamma-2.2 encode and the sRGB decode a
  // sample of it performs.
  let mapped = color / (vec3f(1.0) + color);
  return srgbToLinear3(pow(max(mapped, vec3f(0.0)), vec3f(1.0 / 2.2)));
}

fn ceramicAces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + vec3f(b))) / (color * (c * color + vec3f(d)) + vec3f(e)),
    vec3f(0.0),
    vec3f(1.0),
  );
}

/**
 * Tonemap and encode a reflection for display, copied from `glass-fractal`'s
 * `presentCeramic`.
 *
 * The glass composites against an already-presented wall, so its reflections have
 * to arrive in the same display space the wall was written in.
 */
export fn presentReflection(color: vec3f) -> vec3f {
  return pow(ceramicAces(color * 1.08), vec3f(1.0 / 2.2));
}
