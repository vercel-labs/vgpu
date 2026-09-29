// Lights the liquid as dark smoked glass, after the optics of Liquid Glass
// Studio (github.com/iyinchao/liquid-glass-studio, MIT) and kube.io's "Liquid
// Glass in the Browser", kept quiet so the cards read before the effect does:
// - the bezel bends the floor like the rounded edge of a thick pane: what lies
//   just inside it is stretched out toward the rim, easing to no bend with no
//   crease where it meets the flat glass, with a little dispersion between
//   the colour channels;
// - the pane lifts what is behind it a touch and catches a faint sheen that is
//   strongest on glass near the key light (upper left);
// - a hairline on the rim catches the key light at its corner, thins to a
//   trace along the sides and returns faintly on the far corner, over a soft
//   glow that hugs the lit bevel and a faint Fresnel edge all round;
// - a soft shadow falls on the floor below and to the right, and the glass
//   refracts it like the rest of the floor.
// Past the bezel the glass is flat. The top layer (the open panel, a card
// flying back from it) is the same material over the grid, which shows
// through it faintly.

struct Shade {
  viewport: vec2f,
  fieldTexel: vec2f,
  light: vec3f,
  dpr: f32,
  // How far (CSS px) the rim reaches inward for what it shows. Under half the
  // bezel width the edge magnifies; past it, it mirrors what lies inside.
  refraction: f32,
  // Spread between the colour channels' reach, as a fraction.
  dispersion: f32,
  // Bezel width, CSS px; the pipeline keeps it under every corner radius.
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

// Width (CSS px) over which the Fresnel edge fades from the rim, and the cool
// room light it reflects there.
const FRESNEL_WIDTH = 4.0;
const ENVIRONMENT = vec3f(0.009, 0.0098, 0.0125);
// The soft glow's HDR colour at the rim; it hugs the bevel facing the key.
const SOFT_LIGHT = vec3f(0.05, 0.052, 0.058);
// How tightly the soft glow gathers into the corner facing the key.
const SOFT_FOCUS = 3.0;
// The rim hairline's HDR colour where it faces the key light.
const LINE = vec3f(0.42, 0.44, 0.48) * 0.2;
// Direction to the key light in the screen plane (upper left).
const KEY = vec2f(-0.7071, -0.7071);
// A faint lift the pane adds to everything behind it.
const GLASS_BODY = vec3f(0.0016, 0.0017, 0.0022);
// The key light's sheen on the pane: its HDR colour on glass right under the
// light, where the light sits (uv, as on the floor) and how far the sheen
// reaches, in frame heights.
const SHEEN = vec3f(0.0075, 0.0078, 0.0088);
const KEY_LIGHT = vec2f(-0.08, -0.22);
const SHEEN_REACH = 1.7;
const VGPU_TINT = vec3f(0.35, 0.66, 1.0);
const MOTION_TINT = vec3f(0.66, 0.46, 1.0);
// Drop shadow: offset (CSS px), falloff and strength.
const SHADOW_OFFSET = vec2f(4.0, 14.0);
const SHADOW_FALLOFF = 26.0;
const SHADOW = 0.1;
// How far (CSS px) inside the shape the shadow fades out.
const SHADOW_INNER = 18.0;
// How much of the lit grid shows through the middle of the top layer, and how
// much of the light behind it the top layer's smoked glass lets through.
const GRID_THROUGH = 0.12;
const PANEL_SMOKE = 0.78;

fn tint(hue: f32) -> vec3f {
  return mix(VGPU_TINT, MOTION_TINT, clamp(hue, 0.0, 1.0));
}

fn fieldAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(fieldTex, samp, uv, 0.0);
}

fn backdropAt(uv: vec2f) -> vec3f {
  return textureSampleLevel(backdropTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
}

// The gradient spans a few field texels, so the normal turns smoothly across a
// crease in the field (the middle of a neck) instead of flipping there.
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

struct Rim {
  // Depth inside the edge, CSS px (negative outside).
  depth: f32,
  // Outward unit normal in the screen plane.
  normal: vec2f,
  // 1 on a clean edge, falling to 0 on a ridge of the field (the middle of a
  // neck), where the surface faces the viewer and bends nothing.
  strength: f32,
}

fn rimAt(d: f32, grad: vec2f) -> Rim {
  let len = length(grad);
  let n = select(vec2f(0.0, -1.0), grad / len, len > 1e-4);
  return Rim(-d, n, smoothstep(0.0, 0.7, len));
}

// Past the bezel the glass is flat, clear and unlit.
fn deep(d: f32) -> bool {
  return -d > shade.lens + 2.0;
}

// A band that is 1 at the rim and fades to 0 about `width` px inside it.
fn rimBand(s: f32, width: f32) -> f32 {
  return clamp(pow(max(1.2 - s / width, 0.0), 5.0), 0.0, 1.0);
}

// The soft shadow the glass casts: it falls off outside the offset shape and
// fades out a short way inside it, where the field is still smooth (a
// rounded rect's field folds along its corner diagonals deeper in).
fn shadowAt(uv: vec2f) -> f32 {
  let d = fieldAt(uv - SHADOW_OFFSET / shade.viewport).r;
  let inside = smoothstep(-SHADOW_INNER, 0.0, d);
  return select(inside, exp(-d / SHADOW_FALLOFF), d > 0.0) * SHADOW;
}

fn gridFade() -> f32 {
  return mix(1.0, 0.62, shade.gridDim);
}

// The pointer brightens the glare a little where the rim faces it.
fn pointerGain(n: vec2f, p: vec2f, energy: f32) -> f32 {
  let toLight = shade.light.xy - p;
  let facing = pow(max(dot(n, toLight / max(length(toLight), 1.0)), 0.0), 4.0);
  return (1.0 + 0.3 * facing) * (1.0 + 0.25 * energy);
}

// The key light's sheen on glass at uv.
fn sheenAt(uv: vec2f) -> vec3f {
  let aspect = shade.viewport.x / max(shade.viewport.y, 1.0);
  let d = length((uv - KEY_LIGHT) * vec2f(aspect, 1.0)) / SHEEN_REACH;
  return SHEEN * (1.0 - smoothstep(0.0, 1.0, d));
}

// The floor seen through the pane at uv: a faint lift, the key light's sheen
// and a whisper of the card's library colour.
fn clearGlass(floorColour: vec3f, hue: f32, energy: f32, uv: vec2f) -> vec3f {
  let clear = mix(vec3f(0.975, 0.982, 1.0), vec3f(0.99, 0.975, 1.0), clamp(hue, 0.0, 1.0));
  return floorColour * clear + GLASS_BODY + sheenAt(uv) + tint(hue) * (0.0012 + 0.006 * energy);
}

// How far (CSS px) the bezel at this rim looks inward for what it shows: the
// full `refraction` at the rim, easing to 0 with no slope where the bezel meets
// the flat glass, so the bend leaves no crease there. The bezel is never wider
// than the corner radius (see `lens`), so inside it the field's own normal
// turns smoothly around each corner; deeper in, a rounded rect's field folds
// along the corner diagonals, so no light or bend reaches past the bezel.
fn bezelReach(rim: Rim, energy: f32) -> vec2f {
  let t = clamp(1.0 - rim.depth / max(shade.lens, 1.0), 0.0, 1.0);
  return -rim.normal * shade.refraction * t * t * rim.strength * (1.0 + 0.3 * energy);
}

// The floor seen through the bezel, with a little dispersion between the
// colour channels.
fn refractedFloor(uv: vec2f, reach: vec2f) -> vec3f {
  let spread = shade.dispersion;
  let r = backdropAt(uv + reach * (1.0 - spread) / shade.viewport).r;
  let g = backdropAt(uv + reach / shade.viewport).g;
  let b = backdropAt(uv + reach * (1.0 + spread) / shade.viewport).b;
  return vec3f(r, g, b);
}

// The bezel's light over what it shows: the soft glow, the Fresnel edge and
// the rim hairline. All of it is gone where the bezel meets the flat glass.
fn bezelLight(seen: vec3f, rim: Rim, gain: f32) -> vec3f {
  let s = rim.depth;
  let t = clamp(1.0 - s / max(shade.lens, 1.0), 0.0, 1.0);
  let toward = dot(rim.normal, KEY);
  let lit = max(toward, 0.0);
  let away = max(-toward, 0.0);
  // Thick glass dims a little on the bevel facing away from the light.
  var colour = seen * (1.0 - 0.15 * away * t * t * rim.strength);
  // The soft glow hugs the bevel facing the key light, gathered into that
  // corner and gone before the flat glass.
  colour += SOFT_LIGHT * pow(lit, SOFT_FOCUS) * pow(t, 2.5) * rim.strength * gain;
  // At a grazing angle the rim reflects a faint cool room light all round.
  colour += ENVIRONMENT * rimBand(s, FRESNEL_WIDTH) * rim.strength;
  // The rim hairline: brightest in the corner facing the key light, a trace
  // along the sides, and faintly back on the far corner, where light passing
  // through the pane reflects off its back edge.
  let w = max(0.55, 1.0 / shade.dpr);
  let u = max(s - 0.6, 0.0) / w;
  let line = exp(-u * u) * rim.strength;
  let along = 0.05 + 0.95 * pow(lit, 3.0) + 0.24 * pow(away, 4.0);
  return colour + LINE * line * along * gain;
}

// What the top layer shows through its smoked glass: the lit grid layer
// faintly over the floor, so the rims behind never cross the panel's text.
fn behindPanel(floorColour: vec3f, gridColour: vec3f) -> vec3f {
  return mix(floorColour * gridFade(), gridColour, GRID_THROUGH) * PANEL_SMOKE;
}

fn coverage(d: f32) -> f32 {
  return clamp(0.5 - d * shade.dpr, 0.0, 1.0);
}

// The lit grid layer at uv, including its soft shadow on the floor.
fn gridShade(uv: vec2f, centre: vec4f) -> vec3f {
  let d = centre.r;
  let fade = gridFade();
  if (deep(d)) {
    return clearGlass(backdropAt(uv) * (1.0 - shadowAt(uv)), centre.b, centre.a, uv) * fade;
  }
  // A fine dark hairline just outside the edge keeps the silhouette crisp.
  let hairline = 0.1 * exp(-max(d, 0.0) / 0.7);
  let outside = backdropAt(uv) * (1.0 - shadowAt(uv)) * (1.0 - hairline);
  if (d > 2.0) {
    return outside * fade;
  }
  let p = uv * shade.viewport;
  let rim = rimAt(d, gradientAt(uv).xy);
  let gain = pointerGain(rim.normal, p, centre.a);
  let cov = coverage(d);
  var color = outside;
  if (cov > 0.0) {
    let reach = bezelReach(rim, centre.a);
    // The shadow on the floor shows through the glass where it falls.
    let floorColour = refractedFloor(uv, reach) * (1.0 - shadowAt(uv + reach / shade.viewport));
    color = mix(color, bezelLight(clearGlass(floorColour, centre.b, centre.a, uv), rim, gain), cov);
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
  // The top layer casts a wider, softer shadow on the grid.
  let panelShadow = fieldAt(uv - vec2f(6.0, 24.0) / shade.viewport).g;
  let panelFall = select(smoothstep(-24.0, 0.0, panelShadow), exp(-panelShadow / 36.0), panelShadow > 0.0);
  color *= 1.0 - panelFall * 0.2 * lift;
  if (deep(dp)) {
    let seen = clearGlass(behindPanel(backdropAt(uv), grid), shade.panelHue, shade.panelEnergy, uv);
    color = mix(color, seen, lift);
  } else if (dp < 2.0) {
    let rim = rimAt(dp, gradientAt(uv).zw);
    let cov = coverage(dp) * lift;
    if (cov > 0.0) {
      let gain = pointerGain(rim.normal, p, shade.panelEnergy);
      // The bezel bends the grid layer behind it along with the floor, and
      // shows exactly what the flat glass does where the bend ends.
      let reach = bezelReach(rim, shade.panelEnergy);
      let at = uv + reach / shade.viewport;
      let behind = behindPanel(refractedFloor(uv, reach), gridShade(at, fieldAt(at)));
      let seen = clearGlass(behind, shade.panelHue, shade.panelEnergy, uv);
      color = mix(color, bezelLight(seen, rim, gain), cov);
    }
  }
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
