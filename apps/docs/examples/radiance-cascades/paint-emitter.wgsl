import { sdf_segment, sdf_triangle } from "./sdf-sample.wgsl";

// Accumulates the emitter texture: the fixed triangle plus everything the pointer has
// painted so far. RGB is linear radiance, A is the occluder mask the jump flood seeds from.
//
// Strokes combine with a component-wise max instead of a sum: a slow drag deposits dozens
// of overlapping capsules, and adding them would turn the overlap into a runaway HDR blob
// while max keeps every emitter at exactly the radiance it was painted with.

struct Paint {
  stroke_from: vec2f,
  stroke_to: vec2f,
  /** RGB radiance and an active flag. */
  color: vec4f,
  /** Keep-previous flag and triangle radius. */
  flags: vec4f,
};

@group(0) @binding(0) var<uniform> paint: Paint;
@group(0) @binding(1) var previous: texture_2d<f32>;

/** Warm white: the triangle reads as a light source, not as a coloured shape. */
const TRIANGLE_RADIANCE: vec3f = vec3f(3.8, 3.2, 2.4);

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(previous));
  let pixel = uv * size;
  let texel = vec2i(clamp(floor(pixel), vec2f(0.0), size - 1.0));

  var accumulated = vec4f(0.0);
  if (paint.flags.x > 0.5) {
    accumulated = textureLoad(previous, texel, 0);
  }

  let centre = size * 0.5;
  let r = paint.flags.y;
  // Equilateral, apex up: uv.y grows downwards, so the apex is at -y.
  let apex = centre + vec2f(0.0, -r);
  let left = centre + vec2f(-r * 0.8660254, r * 0.5);
  let right = centre + vec2f(r * 0.8660254, r * 0.5);
  let triangle = 1.0 - smoothstep(
    -1.0,
    1.0,
    sdf_triangle(pixel, apex, right, left),
  );
  accumulated = max(accumulated, vec4f(TRIANGLE_RADIANCE * triangle, triangle));

  if (paint.color.a > 0.5) {
    let stroke = 1.0 - smoothstep(
      -1.0,
      1.0,
      sdf_segment(pixel, paint.stroke_from, paint.stroke_to) - 5.0,
    );
    accumulated = max(accumulated, vec4f(paint.color.rgb * stroke, stroke));
  }

  return accumulated;
}
