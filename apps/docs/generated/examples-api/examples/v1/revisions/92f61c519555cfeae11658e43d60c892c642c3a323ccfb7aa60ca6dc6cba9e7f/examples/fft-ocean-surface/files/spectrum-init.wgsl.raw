// One-time init (re-run whenever wind/amplitude/patch change): builds the
// time-independent Tessendorf spectrum h0.
//   h0[idx].xy = h0(k)            (Phillips amplitude x Gaussian)
//   h0[idx].zw = conj(h0(-k))     (independent Gaussian at the mirrored index)

import { cconj } from "./complex.wgsl";
import { PI, TWO_PI, N, GRAVITY, SimParams } from "./params.wgsl";

@group(0) @binding(0) var<storage, read_write> h0: array<vec4f>;
@group(0) @binding(1) var<uniform> sim: SimParams;

// Integer hash (Murmur-style finalizer) -> uniform f32 in [0, 1).
fn uhash(x: u32) -> u32 {
  var v = x;
  v ^= v >> 16u; v *= 0x7feb352du;
  v ^= v >> 15u; v *= 0x846ca68bu;
  v ^= v >> 16u;
  return v;
}

fn rand(seed: vec2u, salt: u32) -> f32 {
  let h = uhash(seed.x * 1973u + seed.y * 9277u + salt * 26699u + 1u);
  return f32(h) * (1.0 / 4294967296.0);
}

// Two independent standard normals via Box-Muller, packed as a complex number.
fn gauss(seed: vec2u) -> vec2f {
  let u1 = max(rand(seed, 0u), 1e-6);
  let u2 = rand(seed, 1u);
  let r = sqrt(-2.0 * log(u1));
  return vec2f(r * cos(TWO_PI * u2), r * sin(TWO_PI * u2));
}

// Phillips spectrum amplitude for wave-vector k.
fn phillips(k: vec2f) -> f32 {
  let kmag = length(k);
  if (kmag < 1e-4) { return 0.0; }
  let kmag2 = kmag * kmag;
  let bigL = sim.windSpeed * sim.windSpeed / GRAVITY; // largest wave from wind
  let khat = k / kmag;
  let kdotw = dot(khat, normalize(sim.windDir));

  var ph = sim.amplitude * exp(-1.0 / (kmag2 * bigL * bigL)) / (kmag2 * kmag2);
  ph *= kdotw * kdotw;                    // directional spreading
  let small = sim.patchSize / 2000.0;         // suppress tiny ripples
  ph *= exp(-kmag2 * small * small);
  if (kdotw < 0.0) { ph *= 0.07; }        // damp waves moving against the wind
  return ph;
}

@compute @workgroup_size(8, 8)
fn init(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let z = gid.y;
  if (x >= N || z >= N) { return; }
  let idx = z * N + x;

  // Centered frequency indices in [-N/2, N/2).
  let nx = f32(i32(x) - i32(N) / 2);
  let nz = f32(i32(z) - i32(N) / 2);
  let k = TWO_PI * vec2f(nx, nz) / sim.patchSize;

  let phK = phillips(k);
  let phMK = phillips(-k);

  let h0k = sqrt(phK * 0.5) * gauss(vec2u(x, z));
  let mx = (N - x) % N;
  let mz = (N - z) % N;
  let h0mk = sqrt(phMK * 0.5) * gauss(vec2u(mx, mz));

  h0[idx] = vec4f(h0k, cconj(h0mk));
}
