import { TWO_PI, N, GRAVITY, SimParams } from "./params.wgsl";

@group(0) @binding(0) var<storage, read> h0: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> specX: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> specY: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> specZ: array<vec2f>;
@group(0) @binding(4) var<uniform> sim: SimParams;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn cexp(theta: f32) -> vec2f {
  return vec2f(cos(theta), sin(theta));
}

@compute @workgroup_size(8, 8)
fn update(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let z = gid.y;
  if (x >= N || z >= N) { return; }
  let idx = z * N + x;

  let nx = f32(i32(x) - i32(N) / 2);
  let nz = f32(i32(z) - i32(N) / 2);
  let k = TWO_PI * vec2f(nx, nz) / sim.patchSize;
  let kmag = length(k);

  let pair = h0[idx];
  let ex = pair.xy;
  let emk = pair.zw;

  let w = sqrt(GRAVITY * kmag);
  let e = cexp(w * sim.time);
  let ec = vec2f(e.x, -e.y);
  let htilde = cmul(ex, e) + cmul(emk, ec);

  specY[idx] = htilde;

  let khat = select(vec2f(0.0), k / kmag, kmag > 1e-6);
  let nih = vec2f(htilde.y, -htilde.x);
  specX[idx] = nih * khat.x;
  specZ[idx] = nih * khat.y;
}
