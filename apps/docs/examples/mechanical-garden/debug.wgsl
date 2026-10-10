import { Camera } from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;

// One instance per segment: a screen-space capsule from a to b, `width` CSS px wide. A segment
// with a == b draws a dot (foot targets, landing points).
struct SegmentInput {
  @builtin(vertex_index) vertex: u32,
  @location(0) a: vec3f,
  @location(1) b: vec3f,
  // rgb colour, w width in CSS px.
  @location(2) color: vec4f,
}

struct SegmentVarying {
  @builtin(position) clip: vec4f,
  // Position across the capsule in pixels: x along the axis from a, y across it.
  @location(0) local: vec2f,
  @location(1) @interpolate(flat, either) shape: vec2f,
  @location(2) @interpolate(flat, either) color: vec3f,
}

@vertex
fn vs_main(input: SegmentInput) -> SegmentVarying {
  let clipA = camera.viewProjection * vec4f(input.a, 1.0);
  let clipB = camera.viewProjection * vec4f(input.b, 1.0);
  // Keep both ends in front of the camera.
  let wA = max(clipA.w, 1e-3);
  let wB = max(clipB.w, 1e-3);
  let pixels = camera.viewport * 0.5;
  let screenA = clipA.xy / wA * pixels;
  let screenB = clipB.xy / wB * pixels;
  let half = input.color.w * camera.pixelRatio * 0.5;
  let axis = screenB - screenA;
  let span = max(length(axis), 1e-4);
  let along = select(vec2f(1.0, 0.0), axis / span, span > 1e-3);
  let across = vec2f(-along.y, along.x);
  let t = f32(input.vertex & 1u);
  let side = f32(input.vertex >> 1u) * 2.0 - 1.0;
  let extend = (t * 2.0 - 1.0) * half;
  let screen = mix(screenA, screenB, t) + along * extend + across * side * half;
  let w = mix(wA, wB, t);
  let z = mix(clipA.z / wA, clipB.z / wB, t);
  var output: SegmentVarying;
  output.clip = vec4f(screen / pixels * w, z * w, w);
  output.local = vec2f(t * span + extend, side * half);
  output.shape = vec2f(span, half);
  output.color = input.color.rgb;
  return output;
}

@fragment
fn fs_main(input: SegmentVarying) -> @location(0) vec4f {
  // Capsule distance in pixels, with a one-pixel soft edge and a dark outline for contrast.
  let x = clamp(input.local.x, 0.0, input.shape.x);
  let distance = length(input.local - vec2f(x, 0.0));
  let coverage = 1.0 - smoothstep(input.shape.y - 1.0, input.shape.y, distance);
  // A one-device-pixel dark rim around the coloured core.
  let rim = camera.pixelRatio;
  let core = 1.0 - smoothstep(input.shape.y - rim - 0.75, input.shape.y - rim, distance);
  let color = mix(vec3f(0.02), input.color, core);
  return vec4f(color, coverage);
}
