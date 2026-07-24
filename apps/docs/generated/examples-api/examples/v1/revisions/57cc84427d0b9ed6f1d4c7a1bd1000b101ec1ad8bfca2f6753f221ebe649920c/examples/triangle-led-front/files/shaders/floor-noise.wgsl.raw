import { hash21 } from "./hash.wgsl";


struct VSOut { @builtin(position) pos: vec4f };

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  return out;
}


@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let p = floor(in.pos.xy);
  var floor_noise = hash21(p) + hash21(floor(p * 2.12)) + hash21(floor(p * 3.15));
  floor_noise *= 0.3;
  floor_noise = clamp(floor_noise, 0.0, 1.0);
  return vec4f(vec3f(floor_noise), 1.0);
}
