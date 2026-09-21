// An inside-out sphere centered on the camera.

import { skyColor } from "./sky.wgsl";

struct Sky {
  viewProj: mat4x4f,
  camPos: vec3f,
  radius: f32,
  sunDir: vec3f,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> u: Sky;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) dir: vec3f,
}

@vertex fn vs_main(@location(0) position: vec3f) -> VOut {
  var o: VOut;
  let world = position * u.radius + u.camPos;
  o.clip = u.viewProj * vec4f(world, 1.0);
  o.dir = normalize(position);
  return o;
}

@fragment fn fs_main(@location(0) dir: vec3f) -> @location(0) vec4f {
  return vec4f(skyColor(dir, u.sunDir), 1.0);
}
