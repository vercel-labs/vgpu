// Debug entry point: writes the tracer's internal values out as pixels so a test
// can diff them against the CPU reference in `optics.ts`, following
// `vgpu docs cat shader-debugging.md`.
//
// It is not part of the picture. `validation.ts` renders it into a small
// `rgba32float` target, where every value survives readback exactly, so the
// comparison is limited by f32-versus-f64 drift rather than by 8-bit
// quantization.
//
// Layout: one column per probe slot, four rows.
//
//   row 0  the sampled point on the prism's face (xy), its wavelength, its ior
//   row 1  where the ray left the glass (xy) and the unit direction it left with
//   row 2  connection weight, internal bounces, 1 when a path was found, and the
//          scene point the slot probes packed as x (y is in row 3's alpha)
//   row 3  the full 16-ray radiance estimate for this slot (rgb) and probe y
//
// `PROBE_LAYOUT` in `validation.ts` decodes it; keep the two in step.

import { Scene, Ray, estimateRadiance, sceneLamp, scenePrism, sceneRay } from "./scene.wgsl";
import { lightConnection, tracePrism } from "./optics.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;

/**
 * The wall point probe `slot` measures: a grid across the traced plane, spanning
 * the prism and most of the fan it throws.
 *
 * Deliberately covers more than the fan — points inside the glass and points the
 * beam never reaches have to come back empty, and that is worth asserting too. The
 * rows are placed relative to `PRISM_CENTROID`, so they moved with the prism when
 * it moved to the middle of the wall.
 */
fn probePoint(slot: u32) -> vec2f {
  var rows = array<f32, 4>(0.28, -0.04, -0.36, -0.78);
  let column = f32(slot % 8u);
  return vec2f(-1.4 + 0.4 * column, rows[min(slot / 8u, 3u)]);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let slot = u32(position.x);
  let row = u32(position.y);
  let point = probePoint(slot);
  let ray = sceneRay(scene, vec2u(slot, 0u), slot % scene.raysPerFragment);

  if (row == 0u) {
    return vec4f(ray.aim, ray.wavelength, ray.ior);
  }

  let toAim = ray.aim - point;
  let distance = length(toAim);
  let path = tracePrism(scenePrism(scene), point, toAim / distance, ray.ior, scene.maxBounces);
  if (row == 1u) {
    return vec4f(path.origin, path.direction);
  }
  if (row == 2u) {
    var weight = 0.0;
    if (path.valid) {
      weight = lightConnection(sceneLamp(scene), path.origin, path.direction) / (0.35 + distance);
    }
    return vec4f(weight, f32(path.bounces), select(0.0, 1.0, path.valid), point.x);
  }
  return vec4f(estimateRadiance(scene, point, vec2u(slot, 0u)), point.y);
}
