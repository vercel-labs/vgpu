// The scene behind the glass, in linear HDR at CSS-pixel resolution: a pale
// studio floor under a soft key light from the upper left, bright near the
// light and falling off to a cool grey toward the lower right, ruled with a
// fine grid of thin lines so the glass has something to bend.
//
// rgb = the floor; a = 0 (no emissive detail for the glass to re-tint).

struct Backdrop {
  viewport: vec2f,
  time: f32,
  dim: f32,
}

@group(0) @binding(0) var<uniform> backdrop: Backdrop;

// Grid pitch and line width, CSS px.
const CELL = 232.0;
const LINE = 1.0;
// Linear floor colour right under the light and in the far corner.
const LIT = vec3f(1.32, 1.34, 1.38);
const FAR = vec3f(0.07, 0.075, 0.09);
// The light sits above the upper-left corner, a little off frame.
const LIGHT = vec2f(-0.08, -0.22);
// Distance (in frame heights) over which the light falls to the far colour.
const REACH = 2.35;

fn floorColour(uv: vec2f) -> vec3f {
  let aspect = backdrop.viewport.x / max(backdrop.viewport.y, 1.0);
  let d = length((uv - LIGHT) * vec2f(aspect, 1.0)) / REACH;
  // A soft inverse-square-like falloff, eased so the lit corner stays broad.
  let falloff = smoothstep(0.0, 1.0, d);
  return mix(LIT, FAR, pow(falloff, 1.15));
}

// 1 on a grid line, 0 between them. Lines sit on pixel centres and the grid is
// centred in the frame, so both edges of the view end on equal part-cells.
fn gridLine(p: vec2f) -> f32 {
  let offset = (backdrop.viewport - floor(backdrop.viewport / CELL) * CELL) * 0.5;
  let q = p - offset - 0.5;
  let e = abs(fract(q / CELL + 0.5) - 0.5) * CELL;
  let edge = min(e.x, e.y);
  return 1.0 - smoothstep(LINE * 0.5 - 0.35, LINE * 0.5 + 0.65, edge);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * backdrop.viewport;
  var colour = floorColour(uv);
  colour *= 1.0 - 0.5 * gridLine(p);
  let fade = mix(1.0, 0.72, backdrop.dim);
  return vec4f(colour * fade, 0.0);
}
