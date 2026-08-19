// The deliberately sparse studio the prism reflects.
//
// It started as `glass-fractal`'s nine-panel baked cubemap, but this shot only
// needs three intentional edge lights: warm left, cool right and a neutral strip
// below the prism. Evaluating them directly keeps the environment editable in
// one WGSL file and available to both the glass and the mirror-ball debugger.
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

/** Three panels with a dim left fill, soft center fill and dominant right key. */
fn studioPanels() -> array<StudioPanel, 3> {
  return array<StudioPanel, 3>(
    // A warm fill pushed left so it only grazes the left bevel.
    StudioPanel(
      vec3f(-0.78, 0.315, 0.54), // direction
      vec2f(0.44, 0.16), // size
      0.06, // feather
      vec3f(1.0, 0.86, 0.74), // color
      0.65 // intensity
    ),
    // A broad, heavily feathered center fill that barely lifts the bottom edge.
    StudioPanel(
      vec3f(0.0, -0.707, 0.707), // direction
      vec2f(0.38, 0.62), // size
      0.18, // feather
      vec3f(1.0, 0.97, 0.91), // color
      0.22 // intensity
    ),
    // The cool right panel is the dominant key and keeps a more defined edge.
    StudioPanel(
      vec3f(0.612, 0.354, 0.707), // direction
      vec2f(0.5, 0.16), // size
      0.035, // feather
      vec3f(0.76, 0.88, 1.0), // color
      20.0 // intensity
    ),
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
  let floorBlend = 1.0 - smoothstep(-0.22, -0.02, direction.y);
  var room = mix(
    vec3f(0.00025, 0.0003, 0.0004),
    vec3f(0.006, 0.007, 0.009),
    floorBlend,
  );

  // The projection wall occupies the upper part of the -Z hemisphere. Keep the
  // floor below it, but drive the wall itself essentially to black so the prism
  // reflects the same dark surface it physically stands in front of.
  let negativeZ = 1.0 - smoothstep(-0.08, 0.08, direction.z);
  let aboveFloor = smoothstep(-0.28, -0.08, direction.y);
  let backWall = negativeZ * aboveFloor;
  room = mix(room, vec3f(0.00002), backWall);

  // A restrained seam is just bright enough to preserve the floor/wall read.
  let horizon = exp(-abs(direction.y + 0.1) * 22.0) * 0.0012;
  var color = room + vec3f(horizon, horizon * 0.96, horizon * 0.9);
  let panels = studioPanels();
  for (var index = 0u; index < 3u; index = index + 1u) {
    let panel = panels[index];
    color = color + panel.color * (studioPanelMask(direction, panel) * panel.intensity);
  }
  // Filmic compression, then the asset's gamma-2.2 encode and the sRGB decode a
  // sample of it performs.
  let mapped = color / (vec3f(1.0) + color);
  return srgbToLinear3(pow(max(mapped, vec3f(0.0)), vec3f(1.0 / 2.2)));
}
