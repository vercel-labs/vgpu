// Four colored orbs circle the central light on phase-separated elliptical
// tracks. Each instance is one trail segment or a head halo.
struct Params {
  time: f32,
  aspect: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

const POINTS = 192u;
// History spacing: the source pushed one point per 60Hz frame.
const HISTORY_DT = 1.0 / 60.0;
const FOCAL_PX = 360.0;
const HALF_HEIGHT_PX = 240.0;
const HALO_RADIUS_PX = 7.0;
const CORE_RADIUS_PX = 54.0;
const CORE_FEATHER_PX = 18.0;

fn orbit(index: f32, time: f32) -> vec3f {
  let radius = 0.62 + index * 0.34;
  let speed = 0.56 - index * 0.07;
  let angle = time * speed + index * 1.5707963;
  let tilt = -0.42 + index * 0.28;
  let local = vec2f(cos(angle) * radius, sin(angle) * radius * 0.62);
  let c = cos(tilt);
  let s = sin(tilt);
  let xy = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  return vec3f(xy, 3.2 + sin(angle) * 0.28);
}

fn project(p: vec3f) -> vec2f {
  return p.xy * (FOCAL_PX / max(p.z, 0.01));
}

fn coreVisibility(p: vec3f) -> f32 {
  let behind = smoothstep(3.2, 3.32, p.z);
  let core = 1.0 - smoothstep(
    CORE_RADIUS_PX - CORE_FEATHER_PX,
    CORE_RADIUS_PX + CORE_FEATHER_PX,
    length(project(p)),
  );
  return 1.0 - behind * core;
}

fn clip(px: vec2f, aspect: f32) -> vec4f {
  return vec4f(px.x / (HALF_HEIGHT_PX * aspect), px.y / HALF_HEIGHT_PX, 0.0, 1.0);
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) alpha: f32,
  @location(2) local: vec2f,
  @location(3) halo: f32,
}

@vertex fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  var quad = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  var colors = array<vec3f, 4>(
    vec3f(1.0, 0.235, 0.275),
    vec3f(0.47, 1.0, 0.51),
    vec3f(1.0, 0.39, 0.9),
    vec3f(0.47, 0.63, 1.0),
  );
  let trail = instance / POINTS;
  let segment = instance % POINTS;
  let corner = quad[vertex];

  var out: VertexOut;
  out.color = colors[trail];
  out.local = corner;

  if (segment == POINTS - 1u) {
    // Head halo: a small screen-aligned quad with a radial falloff.
    let headPosition = orbit(f32(trail), params.time);
    let head = project(headPosition);
    let centered = vec2f(corner.x * 2.0 - 1.0, corner.y);
    out.position = clip(head + centered * HALO_RADIUS_PX, params.aspect);
    out.local = centered;
    out.alpha = smoothstep(1.2, 2.4, params.time) * coreVisibility(headPosition);
    out.halo = 1.0;
    return out;
  }

  let fade = 1.0 - f32(segment + 1u) / f32(POINTS);
  let t0 = params.time - f32(segment) * HISTORY_DT;
  let t1 = params.time - f32(segment + 1u) * HISTORY_DT;
  let orbit0 = orbit(f32(trail), t0);
  let orbit1 = orbit(f32(trail), t1);
  let p0 = project(orbit0);
  let p1 = project(orbit1);
  let dir = p1 - p0;
  let axis = dir / max(length(dir), 0.0001);
  let perp = vec2f(-axis.y, axis.x);
  let halfWidth = (1.4 * fade + 0.5) * 0.5;
  let px = mix(p0, p1, corner.x) + perp * halfWidth * corner.y;
  out.position = clip(px, params.aspect);
  let visibility = mix(coreVisibility(orbit0), coreVisibility(orbit1), corner.x);
  out.alpha = 0.85 * fade * fade * smoothstep(1.2, 2.4, params.time) * visibility;
  out.halo = 0.0;
  return out;
}

@fragment fn fs_main(
  @location(0) color: vec3f,
  @location(1) alpha: f32,
  @location(2) local: vec2f,
  @location(3) halo: f32,
) -> @location(0) vec4f {
  // Halo: canvas radial-gradient stops 1.0 at the center, 0.5 midway, 0 at the rim.
  let r = length(local);
  let ring = select(
    clamp(mix(0.5, 0.0, (r - 0.5) * 2.0), 0.0, 1.0),
    mix(1.0, 0.5, r * 2.0),
    r < 0.5,
  );
  return vec4f(color, mix(alpha, ring, halo));
}
