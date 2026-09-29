// The scene behind the glass, in linear HDR at device resolution: a dark
// studio floor under a soft key light from the upper left, a dim slate near
// the light falling off to near black toward the lower right, ruled like
// drafting paper — a fine minor grid and a stronger major grid every few
// cells — so the glass has something to bend. Lines are faint light hairlines
// one device pixel wide, aligned to pixel centres.
//
// rgb = the floor; a = 0 (no emissive detail for the glass to re-tint).

struct Backdrop {
  viewport: vec2f,
  time: f32,
  dim: f32,
  dpr: f32,
}

@group(0) @binding(0) var<uniform> backdrop: Backdrop;

// Grid pitch (CSS px), how many minor cells make a major one, line widths
// (CSS px; never thinner than a device pixel, fainter instead) and how much
// each layer lights the floor.
const MINOR = 24.0;
const MAJOR_EVERY = 5.0;
const MINOR_WIDTH = 0.5;
const MAJOR_WIDTH = 1.0;
const MINOR_INK = 0.2;
const MAJOR_INK = 0.55;
// Light a line adds on its own, so the grid still shows in the dark corner.
const LINE_GLOW = vec3f(0.0006, 0.00065, 0.0008);
// Linear floor colour right under the light and in the far corner.
const LIT = vec3f(0.03, 0.032, 0.038);
const FAR = vec3f(0.0018, 0.002, 0.0026);
// A faint indigo glow from beyond the lower-right corner, so the far side of
// the floor is deep blue rather than dead black: colour, centre (uv) and
// reach (frame heights).
const ACCENT = vec3f(0.0016, 0.0014, 0.0048);
const ACCENT_AT = vec2f(1.1, 1.2);
const ACCENT_REACH = 1.2;
// The light sits above the upper-left corner, a little off frame.
const LIGHT = vec2f(-0.08, -0.22);
// Distance (in frame heights) over which the light falls to the far colour.
const REACH = 2.1;

fn floorColour(uv: vec2f) -> vec3f {
  let aspect = backdrop.viewport.x / max(backdrop.viewport.y, 1.0);
  let d = length((uv - LIGHT) * vec2f(aspect, 1.0)) / REACH;
  // A soft inverse-square-like falloff, eased so the lit corner stays broad.
  let falloff = smoothstep(0.0, 1.0, d);
  let accent = 1.0 - smoothstep(0.0, 1.0, length((uv - ACCENT_AT) * vec2f(aspect, 1.0)) / ACCENT_REACH);
  return mix(LIT, FAR, pow(falloff, 1.15)) + ACCENT * accent;
}

// Distance (device px) from `q` to the nearest line of a grid with this pitch.
fn lineDistance(q: vec2f, pitch: f32) -> f32 {
  let e = abs(fract(q / pitch + 0.5) - 0.5) * pitch;
  return min(e.x, e.y);
}

// Ink of a line `width` device px wide at `dist` device px: a line narrower
// than a pixel stays one pixel wide and fades instead, so its weight holds at
// any DPR.
fn lineInk(dist: f32, width: f32) -> f32 {
  let w = max(width, 1.0);
  return min(width, 1.0) * (1.0 - smoothstep(0.5 * w - 0.5, 0.5 * w + 0.5, dist));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dpr = max(backdrop.dpr, 1.0);
  let major = MINOR * MAJOR_EVERY;
  // The major grid is centred in the frame, so both edges of the view end on
  // equal part-cells; the minor grid shares its origin. Working in device px
  // with the origin on a pixel centre keeps every hairline on one pixel.
  let origin = floor((backdrop.viewport - floor(backdrop.viewport / major) * major) * 0.5 * dpr) + 0.5;
  let q = uv * backdrop.viewport * dpr - origin;
  let minor = lineInk(lineDistance(q, MINOR * dpr), MINOR_WIDTH * dpr);
  let majorLine = lineInk(lineDistance(q, major * dpr), MAJOR_WIDTH * dpr);
  let ink = max(MINOR_INK * minor, MAJOR_INK * majorLine) * (1.0 - backdrop.dim * 0.8);
  let colour = floorColour(uv) * (1.0 + ink) + LINE_GLOW * ink;
  let fade = mix(1.0, 0.9, backdrop.dim);
  return vec4f(colour * fade, 0.0);
}
