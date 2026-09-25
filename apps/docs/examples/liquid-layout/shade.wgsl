// Lights the liquid at full resolution as clear water. Inside, the backdrop
// shows through slightly darkened with a faint wash of the card's library
// colour, and its filaments glow brighter than beside the glass. The rim, from
// the outside in: a blue fringe, a crisp white core, a violet fringe, a soft
// bevel glow fading inward, a thin dark band, and under all of it a lens band
// that magnifies the backdrop toward the edge with a little dispersion. The
// rim is brightest on top edges and corners (a meniscus) and where it faces
// the pointer. Deep inside the glass, past the lens band, none of that
// remains, so those pixels skip it. The top layer (the open panel, a card
// flying back from it) is the same material over the grid, which shows through
// it faintly. The air bubbles are drawn over this pass by bubbles.wgsl.

struct Shade {
  viewport: vec2f,
  fieldTexel: vec2f,
  light: vec3f,
  dpr: f32,
  refraction: f32,
  dispersion: f32,
  lens: f32,
  gridDim: f32,
  panelHue: f32,
  panelEnergy: f32,
  // Opacity of the top layer while a blob lifts into it or settles out of it.
  panelLift: f32,
}

@group(0) @binding(0) var fieldTex: texture_2d<f32>;
@group(0) @binding(1) var backdropTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> shade: Shade;

const VGPU_TINT = vec3f(0.35, 0.66, 1.0);
const MOTION_TINT = vec3f(0.66, 0.46, 1.0);
const FRINGE_BLUE = vec3f(0.3, 0.56, 1.0);
const FRINGE_VIOLET = vec3f(0.6, 0.36, 1.0);
const WHITE = vec3f(0.93, 0.96, 1.0);
// Width of the rim in CSS px, up to its dark band.
const TUBE = 6.5;
// How much of the lit grid shows through the middle of the top layer.
const GRID_THROUGH = 0.2;

fn tint(hue: f32) -> vec3f {
  return mix(VGPU_TINT, MOTION_TINT, clamp(hue, 0.0, 1.0));
}

fn band(x: f32, centre: f32, width: f32) -> f32 {
  let u = (x - centre) / width;
  return exp(-u * u);
}

fn fieldAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(fieldTex, samp, uv, 0.0);
}

fn backdropAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(backdropTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}

// The gradient spans a few field texels, so the normal turns smoothly across a
// crease in the field (the middle of a neck, where the distance to its top and
// bottom edges meets) instead of mirroring the refracted backdrop there.
const GRADIENT_SPAN = 2.5;

// Gradients in field units per CSS px: xy = grid, zw = panel. Only pixels on or
// near the glass need them.
fn gradientAt(uv: vec2f) -> vec4f {
  let step = shade.fieldTexel * GRADIENT_SPAN;
  let px = step * shade.viewport;
  let r = fieldAt(uv + vec2f(step.x, 0.0));
  let l = fieldAt(uv - vec2f(step.x, 0.0));
  let d = fieldAt(uv + vec2f(0.0, step.y));
  let u = fieldAt(uv - vec2f(0.0, step.y));
  let gx = (r.rg - l.rg) / (2.0 * px.x);
  let gy = (d.rg - u.rg) / (2.0 * px.y);
  return vec4f(gx.x, gy.x, gx.y, gy.y);
}

struct Surface {
  // Depth inside the rim in CSS px (negative outside).
  depth: f32,
  // The outward normal in the screen plane, scaled down where the field has a
  // ridge (the middle of a neck): the surface there faces the viewer, so it
  // bends nothing and catches no edge light.
  slope: vec2f,
  // 1 at the rim, easing to 0 across the lens band.
  lens: f32,
}

fn surfaceAt(d: f32, grad: vec2f) -> Surface {
  let len = length(grad);
  let n = select(vec2f(0.0, -1.0), grad / len, len > 1e-4);
  let u = clamp(-d / shade.lens, 0.0, 1.0);
  return Surface(-d, n * smoothstep(0.0, 0.7, len), (1.0 - u) * (1.0 - u));
}

// Past this depth (CSS px) the lens band and every rim band have faded out:
// the glass is flat, bends nothing and needs no gradient.
fn deep(d: f32) -> bool {
  return -d > shade.lens + TUBE + 4.0;
}

fn flatAt(d: f32) -> Surface {
  return Surface(-d, vec2f(0.0), 0.0);
}

fn gridFade() -> f32 {
  return mix(1.0, 0.62, shade.gridDim);
}

// The lens band looks inward, more so toward the rim, so what lies behind it
// is magnified; each channel bends by a slightly different amount.
fn refractUv(uv: vec2f, surface: Surface, strength: f32, channel: f32) -> vec2f {
  let offset = -surface.slope * strength * surface.lens * (1.0 + channel * shade.dispersion);
  return uv + offset / shade.viewport;
}

// A meniscus: the rim catches most light along top edges, at corners, and
// where it faces the pointer, and glints unevenly along its length.
fn rimGain(surface: Surface, p: vec2f, energy: f32) -> f32 {
  let n = surface.slope;
  let top = max(-n.y, 0.0);
  let corner = pow(abs(2.0 * n.x * n.y), 3.0);
  let toLight = shade.light.xy - p;
  let key = pow(max(dot(n, toLight / max(length(toLight), 1.0)), 0.0), 4.0);
  let glint = 0.62 + 0.38 * sin(dot(p, vec2f(0.023, 0.017)) + 1.3) * sin(dot(p, vec2f(-0.011, 0.031)) + 0.4);
  return (0.2 + 0.8 * top + 1.0 * corner + 0.5 * key) * glint * (1.0 + 0.35 * energy);
}

fn lineWidth() -> f32 {
  return max(0.7, 1.0 / shade.dpr);
}

// Just outside the edge: a faint blue fringe over a thin dark outline.
fn outerRim(d: f32, colour: vec3f, gain: f32) -> vec3f {
  return mix(FRINGE_BLUE, colour, 0.5) * band(d, 0.9, 1.1) * 0.08 * gain;
}

fn glass(surface: Surface, under: vec3f, veins: f32, hue: f32, gain: f32, energy: f32) -> vec3f {
  let s = surface.depth;
  let colour = tint(hue);
  // Clear water: vgpu glass passes a cool grey, Motion glass lets more red through.
  let clear = mix(vec3f(0.5, 0.54, 0.6), vec3f(0.8, 0.58, 0.66), clamp(hue, 0.0, 1.0));
  let transmit = mix(clear, vec3f(1.0), 0.45 * surface.lens);
  var result = under * transmit + colour * (0.006 + 0.012 * energy);
  // The water gathers the filaments behind it: they glow brighter through the
  // glass than beside it, tinted by the card, most in the lens band.
  result += mix(colour, WHITE, 0.35) * veins * (0.16 + 0.22 * surface.lens);
  // The rim, TUBE px wide: a crisp white line on its outer edge, a violet
  // fringe, and a soft bevel glow fading inward to a thin dark band. The glow
  // follows the rim's gain, so it pools along top edges and in corners.
  result *= 1.0 - 0.35 * band(s, TUBE + 1.8, 1.3);
  let w = lineWidth();
  var rim = WHITE * band(s, 1.1, w + 0.2) * 0.8;
  rim += mix(FRINGE_VIOLET, colour, 0.4) * band(s, 2.6, w + 0.4) * 0.22;
  rim += mix(colour, WHITE, 0.5) * band(s, TUBE, w + 0.25) * 0.04;
  let bevel = smoothstep(0.8, 2.8, s) * exp(-s / 3.4);
  rim += mix(colour, WHITE, 0.45) * bevel * 0.24;
  // Light the lens band gathers: a wide, faint glow inside the rim.
  rim += mix(colour, WHITE, 0.3) * smoothstep(1.5, 5.0, s) * surface.lens * surface.lens * 0.12;
  result += rim * gain;
  return result;
}

fn coverage(d: f32) -> f32 {
  return clamp(0.5 - d * shade.dpr, 0.0, 1.0);
}

// The lit grid layer at uv, including its outline and soft shadow on the backdrop.
fn gridShade(uv: vec2f, centre: vec4f) -> vec3f {
  let d = centre.r;
  let fade = gridFade();
  if (deep(d)) {
    let behind = backdropAt(uv);
    return glass(flatAt(d), behind.rgb, behind.a, centre.b, 0.0, centre.a) * fade;
  }
  let p = uv * shade.viewport;
  let shadowTap = fieldAt(uv - vec2f(0.0, 10.0) / shade.viewport).r;
  let shadow = (1.0 - smoothstep(-16.0, 34.0, shadowTap)) * 0.28;
  let outline = 0.55 * exp(-max(d, 0.0) / 2.2);
  let outside = backdropAt(uv).rgb * (1.0 - shadow) * (1.0 - outline);
  if (d > 4.0) {
    return outside * fade;
  }
  let surface = surfaceAt(d, gradientAt(uv).xy);
  let colour = tint(centre.b);
  let energy = centre.a;
  let gain = rimGain(surface, p, energy);
  var color = outside + outerRim(d, colour, gain);
  let cov = coverage(d);
  if (cov > 0.0) {
    let strength = shade.refraction * (1.0 + 0.5 * energy);
    let red = backdropAt(refractUv(uv, surface, strength, -1.0));
    let green = backdropAt(refractUv(uv, surface, strength, 0.0));
    let blue = backdropAt(refractUv(uv, surface, strength, 1.0));
    let under = vec3f(red.r, green.g, blue.b);
    color = mix(color, glass(surface, under, green.a, centre.b, gain, energy), cov);
  }
  return color * fade;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * shade.viewport;
  let here = fieldAt(uv);
  let grid = gridShade(uv, here);
  var color = grid;

  let dp = here.g;
  let lift = shade.panelLift;
  if (lift <= 0.0) {
    return vec4f(max(color, vec3f(0.0)), 1.0);
  }
  // The top layer's shadow falls wide and soft on the grid, inside a thin outline.
  let panelShadow = fieldAt(uv - vec2f(0.0, 22.0) / shade.viewport).g;
  color *= 1.0 - (1.0 - smoothstep(-20.0, 80.0, panelShadow)) * 0.5 * lift;
  color *= 1.0 - 0.5 * exp(-max(dp, 0.0) / 2.2) * lift;
  // Under the top layer the grid's light fades toward the plain room, as its
  // copy does, so the rims behind never cross the panel's text; it comes back
  // in the panel's lens band.
  if (deep(dp)) {
    let behind = backdropAt(uv);
    let under = mix(behind.rgb * gridFade(), grid, GRID_THROUGH);
    let lit = glass(flatAt(dp), under, behind.a, shade.panelHue, 0.0, shade.panelEnergy);
    color = mix(color, lit, lift);
  } else if (dp < 4.0) {
    let surface = surfaceAt(dp, gradientAt(uv).zw);
    let colour = tint(shade.panelHue);
    let gain = rimGain(surface, p, shade.panelEnergy);
    color += outerRim(dp, colour, gain) * lift;
    let cov = coverage(dp) * lift;
    if (cov > 0.0) {
      let seen = clamp(refractUv(uv, surface, shade.refraction * 1.4, 0.0), vec2f(0.0), vec2f(1.0));
      let behind = backdropAt(seen);
      let through = GRID_THROUGH + (1.0 - GRID_THROUGH) * surface.lens;
      let under = mix(behind.rgb * gridFade(), gridShade(seen, fieldAt(seen)), through);
      let lit = glass(surface, under, behind.a, shade.panelHue, gain, shade.panelEnergy);
      color = mix(color, lit, cov);
    }
  }
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
