struct Params {
  resolution: vec2f,
  yaw: f32,
  pitch: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

const V0 = vec3f(0.0, 1.0, 0.0);
const V1 = vec3f(0.94280904158, -0.33333333333, 0.0);
const V2 = vec3f(-0.47140452079, -0.33333333333, 0.81649658093);
const V3 = vec3f(-0.47140452079, -0.33333333333, -0.81649658093);

fn closestVertex(p: vec3f) -> vec3f {
  var vertex = V0;
  var score = dot(p, V0);
  let score1 = dot(p, V1); if (score1 > score) { score = score1; vertex = V1; }
  let score2 = dot(p, V2); if (score2 > score) { score = score2; vertex = V2; }
  let score3 = dot(p, V3); if (score3 > score) { vertex = V3; }
  return vertex;
}

fn fractalDistance(point: vec3f) -> f32 {
  var p = point;
  p = 2.0 * p - closestVertex(p);
  p = 2.0 * p - closestVertex(p);
  p = 2.0 * p - closestVertex(p);
  p = 2.0 * p - closestVertex(p);
  p = 2.0 * p - closestVertex(p);
  p = 2.0 * p - closestVertex(p);
  let d = max(max(dot(-V0, p), dot(-V1, p)), max(dot(-V2, p), dot(-V3, p))) - 0.33333333333;
  return d / 64.0;
}

fn clipPlane(ro: vec3f, rd: vec3f, normal: vec3f, interval: vec2f) -> vec2f {
  let a = dot(normal, ro) - 0.33333333333;
  let b = dot(normal, rd);
  if (abs(b) < 0.000001) {
    if (a > 0.0) { return vec2f(1.0, -1.0); }
    return interval;
  }
  let t = -a / b;
  if (b < 0.0) { return vec2f(max(interval.x, t), interval.y); }
  return vec2f(interval.x, min(interval.y, t));
}

fn outerInterval(ro: vec3f, rd: vec3f) -> vec2f {
  var bound = vec2f(-100000.0, 100000.0);
  bound = clipPlane(ro, rd, -V0, bound);
  bound = clipPlane(ro, rd, -V1, bound);
  bound = clipPlane(ro, rd, -V2, bound);
  bound = clipPlane(ro, rd, -V3, bound);
  return bound;
}

fn normalAt(p: vec3f, e: f32) -> vec3f {
  let k0 = vec3f(1.0, -1.0, -1.0);
  let k1 = vec3f(-1.0, -1.0, 1.0);
  let k2 = vec3f(-1.0, 1.0, -1.0);
  let k3 = vec3f(1.0, 1.0, 1.0);
  return normalize(k0 * fractalDistance(p + k0 * e) + k1 * fractalDistance(p + k1 * e) +
    k2 * fractalDistance(p + k2 * e) + k3 * fractalDistance(p + k3 * e));
}

fn ambientOcclusion(p: vec3f, n: vec3f) -> f32 {
  let d0 = fractalDistance(p + n * 0.012);
  let d1 = fractalDistance(p + n * 0.028);
  let d2 = fractalDistance(p + n * 0.060);
  let d3 = fractalDistance(p + n * 0.120);
  let occlusion = max(0.0, 0.012 - d0) * 8.0 + max(0.0, 0.028 - d1) * 3.0 +
    max(0.0, 0.060 - d2) * 1.2 + max(0.0, 0.120 - d3) * 0.35;
  return clamp(1.0 - occlusion, 0.55, 1.0);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cp = cos(params.pitch); let sp = sin(params.pitch);
  let cy = cos(params.yaw); let sy = sin(params.yaw);
  let ro = vec3f(3.15 * sy * cp, 3.15 * sp, 3.15 * cy * cp);
  let forward = normalize(-ro);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  var screen = uv * 2.0 - 1.0;
  screen.y = -screen.y;
  screen.x *= params.resolution.x / max(params.resolution.y, 1.0);
  let rd = normalize(forward + (right * screen.x + up * screen.y) * 0.32491969623);
  let bound = outerInterval(ro, rd);
  if (bound.x > bound.y || bound.y < 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }

  var t = max(bound.x, 0.0);
  var eps = max(0.0008, 0.0003 * t);
  var hit = false;
  for (var step = 0; step < 96; step++) {
    let d = fractalDistance(ro + rd * t);
    eps = max(0.0008, 0.0003 * t);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.8, eps * 0.5);
    if (t > bound.y || t > 6.0) { break; }
  }
  if (!hit || t > bound.y + eps || t > 6.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let p = ro + rd * t;
  let n = normalAt(p, max(0.0015, 2.0 * eps));
  let light = normalize(vec3f(-0.55, 0.78, 0.30));
  let diffuse = max(dot(n, light), 0.0);
  let ao = ambientOcclusion(p, n);
  let color = vec3f(1.0) * ao * (0.11 + 1.55 * diffuse);
  return vec4f(color, 1.0);
}
