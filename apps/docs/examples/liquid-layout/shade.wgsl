// Lights the liquid as clear glass, after the optics of Liquid Glass Studio
// (github.com/iyinchao/liquid-glass-studio, MIT) and kube.io's "Liquid Glass
// in the Browser":
// - the bezel bends the floor by Snell's law: a ray entering the rim at
//   incidence asin(x^1.4) (x = 1 at the edge, 0 where the bezel ends) lands
//   tan(θi − θt) further inward, so the floor is compressed hardest right at
//   the rim, with a little dispersion between the colour channels;
// - a Fresnel band lightens the rim;
// - a glare highlight runs along the rim, strongest on the corners facing the
//   key light (upper left) and, a little weaker, on the opposite ones, and
//   carries a hint of the colour behind it;
// - a soft shadow falls on the floor below and to the right, and the glass
//   refracts it like the rest of the floor.
// Past the bezel the glass is flat and clear. The top layer (the open panel,
// a card flying back from it) is the same material over the grid, which shows
// through it faintly.

struct Shade {
  viewport: vec2f,
  fieldTexel: vec2f,
  light: vec3f,
  dpr: f32,
  // How far (CSS px) the rim reaches inward for what it shows.
  refraction: f32,
  // Spread between the colour channels' reach, as a fraction.
  dispersion: f32,
  // Bezel width, CSS px.
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

const IOR = 1.4;
// Widths (CSS px) over which the Fresnel and glare bands fade from the rim.
const FRESNEL_WIDTH = 5.4;
// The glare is wider on the lit lobe than on the opposite one.
const GLARE_WIDTH = 7.0;
const COUNTER_GLARE_WIDTH = 3.6;
// Direction to the key light in the screen plane (upper left).
const KEY = vec2f(-0.7071, -0.7071);
// Colour of the room the steep rim reflects on the side away from the light.
const ROOM = vec3f(0.16, 0.165, 0.18);
// The glare's peak colour: HDR white, so it reads on the pale floor.
const GLARE = vec3f(1.9, 1.92, 1.96);
const VGPU_TINT = vec3f(0.35, 0.66, 1.0);
const MOTION_TINT = vec3f(0.66, 0.46, 1.0);
// Drop shadow: offset (CSS px), falloff and strength.
const SHADOW_OFFSET = vec2f(4.0, 14.0);
const SHADOW_FALLOFF = 22.0;
const SHADOW = 0.16;
// How much of the lit grid shows through the middle of the top layer.
const GRID_THROUGH = 0.2;

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

// Past the bezel the glass is flat: nothing bends and no rim light remains.
fn deep(d: f32) -> bool {
  return -d > max(shade.lens, FRESNEL_WIDTH * 1.3) + 2.0;
}

// Snell's law across the bezel: the inward reach at depth s, as a fraction of
// `refraction`. 0.98 at the edge for IOR 1.4, easing to 0 where the bezel ends.
fn edgeReach(s: f32) -> f32 {
  let x = clamp(1.0 - s / max(shade.lens, 1.0), 0.0, 1.0);
  let thetaI = asin(pow(x, 1.4));
  let thetaT = asin(sin(thetaI) / IOR);
  return tan(thetaI - thetaT);
}

// A band that is 1 at the rim and fades to 0 about `width` px inside it.
fn rimBand(s: f32, width: f32) -> f32 {
  return clamp(pow(max(1.2 - s / width, 0.0), 5.0), 0.0, 1.0);
}

// Two lobes along the rim: full on the corners facing the key light (upper
// left, normal (−1, −1)) and on the opposite ones, a little weaker there;
// none on the other two corners.
fn glareLobes(n: vec2f) -> f32 {
  let lobe = 0.5 + n.x * n.y;
  let side = select(1.2, 0.96, dot(n, vec2f(-1.0, -1.0)) < 0.0);
  return clamp(pow(lobe * side * 0.9, 1.1), 0.0, 1.0);
}

fn shadowAt(uv: vec2f) -> f32 {
  let d = fieldAt(uv - SHADOW_OFFSET / shade.viewport).r;
  return exp(-abs(d) / SHADOW_FALLOFF) * SHADOW;
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

// The floor seen through clear glass: a whisper of the card's library colour.
fn clearGlass(floorColour: vec3f, hue: f32, energy: f32) -> vec3f {
  let clear = mix(vec3f(0.975, 0.982, 1.0), vec3f(0.99, 0.975, 1.0), clamp(hue, 0.0, 1.0));
  return floorColour * clear + tint(hue) * (0.003 + 0.01 * energy);
}

// Glass on the bezel at uv: refraction with dispersion, the Fresnel band and
// the glare.
fn bezel(uv: vec2f, rim: Rim, hue: f32, energy: f32, gain: f32) -> vec3f {
  let s = rim.depth;
  let reach = -rim.normal * edgeReach(s) * rim.strength * shade.refraction * (1.0 + 0.4 * energy);
  let spread = shade.dispersion;
  let r = backdropAt(uv + reach * (1.0 - spread) / shade.viewport).r;
  let g = backdropAt(uv + reach / shade.viewport).g;
  let b = backdropAt(uv + reach * (1.0 + spread) / shade.viewport).b;
  // The shadow on the floor shows through the glass where it falls.
  var colour = clearGlass(vec3f(r, g, b) * (1.0 - shadowAt(uv + reach / shade.viewport)), hue, energy);
  let facing = dot(rim.normal, KEY);
  // Thick glass gathers light on the bevel facing the key and dims on the far
  // one, fading smoothly toward the flat top.
  let lens = pow(clamp(1.0 - s / max(shade.lens, 1.0), 0.0, 1.0), 2.0) * rim.strength;
  colour *= 1.0 + 0.2 * facing * lens;
  let fresnel = rimBand(s, FRESNEL_WIDTH) * rim.strength;
  colour = mix(colour, colour * 1.18 + vec3f(0.04), fresnel * 0.55);
  // At a grazing angle the steep rim on the far side reflects the dim room:
  // a fine dark edge that fades out toward the light.
  let grazing = rimBand(s, 2.4) * rim.strength * smoothstep(0.35, -0.6, facing);
  colour = mix(colour, ROOM, grazing * 0.55);
  let lit = facing > 0.0;
  let width = select(COUNTER_GLARE_WIDTH, GLARE_WIDTH, lit);
  let glare = glareLobes(rim.normal) * rimBand(s, width) * rim.strength * gain;
  colour = mix(colour, GLARE + colour * 0.25, clamp(glare, 0.0, 1.0));
  return colour;
}

fn coverage(d: f32) -> f32 {
  return clamp(0.5 - d * shade.dpr, 0.0, 1.0);
}

// The lit grid layer at uv, including its soft shadow on the floor.
fn gridShade(uv: vec2f, centre: vec4f) -> vec3f {
  let d = centre.r;
  let fade = gridFade();
  if (deep(d)) {
    return clearGlass(backdropAt(uv) * (1.0 - shadowAt(uv)), centre.b, centre.a) * fade;
  }
  // A fine grey hairline just outside the edge keeps the silhouette on the
  // pale floor.
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
    color = mix(color, bezel(uv, rim, centre.b, centre.a, gain), cov);
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
  color *= 1.0 - exp(-abs(panelShadow) / 36.0) * 0.2 * lift;
  // Under the top layer the grid fades toward the plain floor, so the rims
  // behind never cross the panel's text; it comes back near the panel's rim.
  if (deep(dp)) {
    let under = mix(backdropAt(uv) * gridFade(), grid, GRID_THROUGH);
    color = mix(color, clearGlass(under, shade.panelHue, shade.panelEnergy), lift);
  } else if (dp < 2.0) {
    let rim = rimAt(dp, gradientAt(uv).zw);
    let cov = coverage(dp) * lift;
    if (cov > 0.0) {
      let gain = pointerGain(rim.normal, p, shade.panelEnergy);
      let lit = bezel(uv, rim, shade.panelHue, shade.panelEnergy, gain);
      let through = GRID_THROUGH + (1.0 - GRID_THROUGH) * rimBand(rim.depth, shade.lens * 0.5);
      color = mix(color, mix(lit * gridFade(), lit * 0.5 + grid * 0.5, through * 0.5), cov);
    }
  }
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
