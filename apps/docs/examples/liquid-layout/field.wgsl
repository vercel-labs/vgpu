// Distance field of the liquid, rendered at CSS-pixel resolution. Every
// primitive (card bodies, necks, droplets, drips) is blended into its layer
// with a polynomial smooth-min whose radius comes from the primitive, so a fast
// or dragged card melts into whatever it passes while resting cards keep crisp
// gaps. Card edges bulge and wobble slowly, like surface tension.
//
// Output: r = grid distance, g = panel distance (CSS px, negative inside),
//         b = blended hue (0 pale blue → 1 lavender), a = blended energy.
//
// Primitive layout, four vec4f each:
//   rect:    p0 = centre.xy, half.xy   p1 = corner, k, kind, hue
//            p2 = world→local 2×2      p3 = erode, energy, distScale, wobble
//   capsule: p0 = a.xy, b.xy           p1 = radiusA, k, kind, hue
//            p2 = radiusB, -, -, -     p3 = erode, energy, 1, -
//   bridge:  p0 = centre.xy, half length, fillet   p1 = waist, k, kind, hue
//            p3 = -, energy, -, -
// kind: 0 rect, 1 capsule, 8 bridge (grid layer only); +2 for the panel layer;
// +4 blends with its own radius only (a droplet on a neck stays a droplet).
// wobble = phase * 16 + amplitude (CSS px, < 16).

const MAX_PRIMS = 32u;
const FAR = 256.0;

struct Field {
  viewport: vec2f,
  count: u32,
  time: f32,
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

// A horizontal bar `waist` thick on each side of its axis; below zero it is a
// line that only its fillets can reach.
fn sdBar(p: vec2f, centre: vec2f, halfLength: f32, waist: f32) -> f32 {
  let q = abs(p - centre);
  return length(vec2f(max(q.x - halfLength, 0.0), q.y)) - waist;
}

// How far each edge bulges out at this point: most at mid-edge, none at the
// corners, each edge breathing on its own two slow harmonics.
fn bulge(v: vec2f, t: f32, phase: f32, amp: f32) -> vec2f {
  let side = smoothstep(vec2f(-0.3), vec2f(0.3), v);
  // left, right, top, bottom
  let offsets = vec4f(0.0, 2.1, 4.2, 5.3);
  let edges = amp * (0.62
    + 0.26 * sin(t * vec4f(0.53, 0.61, 0.47, 0.71) + phase + offsets)
    + 0.12 * sin(t * vec4f(1.13, 0.97, 1.31, 1.07) + 1.7 * phase + offsets));
  // A slow tilt and a lump travelling along each edge keep the bow uneven.
  let alongX = 1.0 + 0.35 * sin(0.37 * t + 1.3 * phase) * v.y + 0.4 * sin(4.4 * v.y + 0.29 * t + 2.0 * phase);
  let alongY = 1.0 + 0.35 * sin(0.41 * t + 0.7 * phase) * v.x + 0.4 * sin(4.9 * v.x + 0.23 * t + 2.6 * phase);
  let ex = mix(edges.x, edges.y, side.x) * max(0.0, 1.0 - v.y * v.y) * alongX;
  let ey = mix(edges.z, edges.w, side.y) * max(0.0, 1.0 - v.x * v.x) * alongY;
  return vec2f(ex, ey);
}

struct Accum {
  d: f32,
  k: f32,
  hue: f32,
  energy: f32,
}

fn blend(acc: Accum, d: f32, radius: f32, k: f32, hue: f32, energy: f32) -> Accum {
  // Weight of the accumulated surface; 0 means the new primitive wins.
  let h = clamp(0.5 + 0.5 * (d - acc.d) / radius, 0.0, 1.0);
  var out: Accum;
  out.d = mix(d, acc.d, h) - radius * h * (1.0 - h);
  out.k = mix(k, acc.k, h);
  out.hue = mix(hue, acc.hue, h);
  out.energy = mix(energy, acc.energy, h);
  return out;
}

// A union whose fillet is a circular arc of `radius` tangent to both surfaces,
// wherever the wobbling edges happen to be. The polynomial blend above cannot
// do this: its fillet reaches only radius / 4 into the corner, so a bar between
// two cards joins them as a stiff H instead of flaring into each edge.
fn fillet(acc: Accum, d: f32, radius: f32, k: f32, hue: f32, energy: f32) -> Accum {
  var out = blend(acc, d, radius, k, hue, energy);
  out.d = max(radius, min(acc.d, d)) - length(max(vec2f(radius) - vec2f(acc.d, d), vec2f(0.0)));
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
    let onPanel = (kind & 2u) != 0u;
    let accD = select(grid.d, panel.d, onPanel);
    let radius = select(max(max(p1.y, select(grid.k, panel.k, onPanel)), 1.0), max(p1.y, 1.0), (kind & 4u) != 0u);
    var d: f32;
    if ((kind & 8u) != 0u) {
      // Bridges live in the grid layer and flare into it with their own fillet.
      grid = fillet(grid, sdBar(p, p0.xy, p0.z, p1.x), max(p0.w, 1.0), p1.y, p1.w, p3.y);
      continue;
    }
    if ((kind & 1u) == 0u) {
      let offset = p - p0.xy;
      let local = vec2f(dot(p2.xy, offset), dot(p2.zw, offset));
      var half = p0.zw;
      let seed = floor(p3.w / 16.0);
      let amp = p3.w - seed * 16.0;
      // A card at least `radius` beyond the surface so far leaves the blend
      // unchanged, so skip its bulge: each edge bows out by at most 1.75 × amp.
      let nearest = (sdRoundRect(local, half, p1.x) - 2.5 * amp) * p3.z + p3.x;
      if (nearest >= accD + radius) {
        continue;
      }
      if (amp > 0.01) {
        half += bulge(clamp(local / half, vec2f(-1.0), vec2f(1.0)), field.time, seed * 2.39996, amp);
      }
      d = sdRoundRect(local, half, p1.x) * p3.z;
    } else {
      d = sdTaperedCapsule(p, p0.xy, p0.zw, p1.x, p2.x);
    }
    d += p3.x;
    if (onPanel) {
      panel = blend(panel, d, radius, p1.y, p1.w, p3.y);
    } else {
      grid = blend(grid, d, radius, p1.y, p1.w, p3.y);
    }
  }
  return vec4f(clamp(grid.d, -FAR, FAR), clamp(panel.d, -FAR, FAR), grid.hue, grid.energy);
}
