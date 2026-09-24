// Distance field of the liquid, rendered at CSS-pixel resolution. Every
// primitive (card bodies, tether ropes, droplets) is blended into its layer
// with a polynomial smooth-min whose radius comes from the primitive, so a fast
// card melts into whatever it passes while resting cards keep crisp gaps.
//
// Output: r = grid distance, g = panel distance (CSS px, negative inside),
//         b = blended hue (0 azure → 1 magenta), a = blended energy.
//
// Primitive layout, four vec4f each:
//   rect:    p0 = centre.xy, half.xy   p1 = corner, k, kind, hue
//            p2 = world→local 2×2      p3 = erode, energy, distScale, -
//   capsule: p0 = a.xy, b.xy           p1 = radiusA, k, kind, hue
//            p2 = radiusB, -, -, -     p3 = erode, energy, 1, -
// kind: 0 rect, 1 capsule; +2 for the panel layer.

const MAX_PRIMS = 32u;
const FAR = 256.0;

struct Field {
  viewport: vec2f,
  count: u32,
  pad: f32,
  prims: array<vec4f, 128>,
}

@group(0) @binding(0) var<uniform> field: Field;

fn sdRoundRect(p: vec2f, half: vec2f, corner: f32) -> f32 {
  let r = min(corner, min(half.x, half.y));
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Tapered capsule between a (radius ra) and b (radius rb).
fn sdTaperedCapsule(p: vec2f, a: vec2f, b: vec2f, ra: f32, rb: f32) -> f32 {
  let axis = b - a;
  let h = length(axis);
  if (h <= abs(ra - rb) + 0.001) {
    return min(length(p - a) - ra, length(p - b) - rb);
  }
  let dir = axis / h;
  let local = vec2f(abs(dot(p - a, vec2f(dir.y, -dir.x))), dot(p - a, dir));
  let s = (ra - rb) / h;
  let c = sqrt(1.0 - s * s);
  let k = dot(local, vec2f(-s, c));
  if (k < 0.0) {
    return length(local) - ra;
  }
  if (k > c * h) {
    return length(local - vec2f(0.0, h)) - rb;
  }
  return dot(local, vec2f(c, s)) - ra;
}

struct Accum {
  d: f32,
  k: f32,
  hue: f32,
  energy: f32,
}

fn blend(acc: Accum, d: f32, k: f32, hue: f32, energy: f32) -> Accum {
  let radius = max(max(k, acc.k), 1.0);
  // Weight of the accumulated surface; 0 means the new primitive wins.
  let h = clamp(0.5 + 0.5 * (d - acc.d) / radius, 0.0, 1.0);
  var out: Accum;
  out.d = mix(d, acc.d, h) - radius * h * (1.0 - h);
  out.k = mix(k, acc.k, h);
  out.hue = mix(hue, acc.hue, h);
  out.energy = mix(energy, acc.energy, h);
  return out;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * field.viewport;
  var grid = Accum(FAR, 1.0, 0.0, 0.0);
  var panel = Accum(FAR, 1.0, 0.0, 0.0);
  let count = min(field.count, MAX_PRIMS);
  for (var i = 0u; i < count; i++) {
    let p0 = field.prims[i * 4u];
    let p1 = field.prims[i * 4u + 1u];
    let p2 = field.prims[i * 4u + 2u];
    let p3 = field.prims[i * 4u + 3u];
    let kind = u32(p1.z + 0.5);
    var d: f32;
    if ((kind & 1u) == 0u) {
      let offset = p - p0.xy;
      let local = vec2f(dot(p2.xy, offset), dot(p2.zw, offset));
      d = sdRoundRect(local, p0.zw, p1.x) * p3.z;
    } else {
      d = sdTaperedCapsule(p, p0.xy, p0.zw, p1.x, p2.x);
    }
    d += p3.x;
    if (kind >= 2u) {
      panel = blend(panel, d, p1.y, p1.w, p3.y);
    } else {
      grid = blend(grid, d, p1.y, p1.w, p3.y);
    }
  }
  return vec4f(clamp(grid.d, -FAR, FAR), clamp(panel.d, -FAR, FAR), grid.hue, grid.energy);
}
