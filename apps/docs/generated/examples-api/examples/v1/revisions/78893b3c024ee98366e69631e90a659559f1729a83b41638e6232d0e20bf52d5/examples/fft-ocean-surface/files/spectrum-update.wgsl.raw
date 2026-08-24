// Per-frame time evolution of the spectrum, producing the three frequency-domain
// fields the IFFT turns into spatial displacement:
//   specY = h(k,t)                (vertical height)
//   specX = -i * kx/|k| * h(k,t)  (horizontal displacement; choppiness scaled at render)
//   specZ = -i * kz/|k| * h(k,t)
// with h(k,t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}, w = sqrt(g|k|).

import { cmul, cexp } from "./complex.wgsl";
import { TWO_PI, N, GRAVITY, SimParams } from "./params.wgsl";

@group(0) @binding(0) var<storage, read> h0: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> specX: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> specY: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> specZ: array<vec2f>;
@group(0) @binding(4) var<uniform> sim: SimParams;

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
  let ex = pair.xy;   // h0(k)
  let emk = pair.zw;  // conj(h0(-k))

  let w = sqrt(GRAVITY * kmag);
  let e = cexp(w * sim.time);            // e^{i w t}
  let ec = vec2f(e.x, -e.y);             // e^{-i w t}
  let htilde = cmul(ex, e) + cmul(emk, ec);

  specY[idx] = htilde;

  // Horizontal displacement spectrum: -i * khat * htilde.
  let khat = select(vec2f(0.0), k / kmag, kmag > 1e-6);
  let nih = vec2f(htilde.y, -htilde.x); // -i * htilde
  specX[idx] = nih * khat.x;
  specZ[idx] = nih * khat.y;
}
