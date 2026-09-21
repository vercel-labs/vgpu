// Procedural grid displaced by the FFT texture, with per-pixel normals and foam.

import { skyColor } from "./sky.wgsl";

override GRID: u32 = 512u;
const NU: u32 = 256u;

struct Ocean {
  viewProj: mat4x4f,
  camPos: vec3f,
  worldSize: f32,
  sunDir: vec3f,
  patchSize: f32,
  heightScale: f32,
  choppyScale: f32,
  foamScale: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> u: Ocean;
@group(0) @binding(1) var disp: texture_2d<f32>;
@group(0) @binding(2) var dispSamp: sampler;

fn sampleDisp(uv: vec2f) -> vec3f {
  return textureSampleLevel(disp, dispSamp, uv, 0.0).xyz;
}

fn scaled(d: vec3f) -> vec3f {
  return vec3f(d.x * u.choppyScale, d.y * u.heightScale, d.z * u.choppyScale);
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  let cell = vi / 6u;
  let corner = vi % 6u;
  let cx = cell % GRID;
  let cz = cell / GRID;

  var offs = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  let o = offs[corner];
  let g = vec2f(f32(cx + o.x), f32(cz + o.y)) / f32(GRID);
  let base = (g - 0.5) * u.worldSize;

  let uv = base / u.patchSize;
  let world = vec3f(base.x, 0.0, base.y) + scaled(sampleDisp(uv));

  var out: VOut;
  out.clip = u.viewProj * vec4f(world, 1.0);
  out.world = world;
  out.uv = uv;
  return out;
}

@fragment fn fs_main(@location(0) world: vec3f, @location(1) uv: vec2f) -> @location(0) vec4f {
  let e = 1.0 / f32(NU);
  let dwx = u.patchSize / f32(NU);

  let dC = sampleDisp(uv);
  let dX = sampleDisp(uv + vec2f(e, 0.0));
  let dZ = sampleDisp(uv + vec2f(0.0, e));

  let tX = vec3f(
    dwx + (dX.x - dC.x) * u.choppyScale,
    (dX.y - dC.y) * u.heightScale,
    (dX.z - dC.z) * u.choppyScale,
  );
  let tZ = vec3f(
    (dZ.x - dC.x) * u.choppyScale,
    (dZ.y - dC.y) * u.heightScale,
    dwx + (dZ.z - dC.z) * u.choppyScale,
  );
  var n = normalize(cross(tZ, tX));
  if (n.y < 0.0) { n = -n; }

  let dDxdx = (dX.x - dC.x) * u.choppyScale / dwx;
  let dDzdz = (dZ.z - dC.z) * u.choppyScale / dwx;
  let dDxdz = (dZ.x - dC.x) * u.choppyScale / dwx;
  let dDzdx = (dX.z - dC.z) * u.choppyScale / dwx;
  let jac = (1.0 + dDxdx) * (1.0 + dDzdz) - dDxdz * dDzdx;
  let foam = smoothstep(u.foamScale, u.foamScale * 0.35, jac);

  let v = normalize(u.camPos - world);
  let sun = normalize(u.sunDir);
  let dist = length(u.camPos - world);

  let r = reflect(-v, n);
  let refl = skyColor(r, u.sunDir);
  let f0 = 0.02;
  let fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);

  let facing = max(dot(n, v), 0.0);
  let deep = vec3f(0.002, 0.028, 0.055);
  let shallow = vec3f(0.03, 0.16, 0.19);
  var water = mix(deep, shallow, pow(facing, 0.5));
  let crest = clamp(world.y * 0.06 + 0.35, 0.0, 1.0);
  let sss = pow(max(dot(v, -sun), 0.0), 3.0) * crest;
  water += vec3f(0.95, 0.34, 0.14) * sss * 0.8;

  let fresW = mix(0.03, 0.92, fres);
  var col = mix(water, refl, fresW);

  let h = normalize(sun + v);
  let spec = pow(max(dot(n, h), 0.0), 600.0);
  col += vec3f(1.8, 1.1, 0.62) * spec * 4.5;

  col = mix(col, vec3f(0.96, 0.90, 0.84), foam);

  let dir = normalize(world - u.camPos);
  let horizonCol = skyColor(normalize(vec3f(dir.x, 0.04, dir.z)), u.sunDir);
  let fog = smoothstep(u.worldSize * 0.42, u.worldSize * 0.62, dist);
  col = mix(col, horizonCol, fog);

  return vec4f(col, 1.0);
}
