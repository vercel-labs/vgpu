
struct Config { cascade: vec4f, params: vec4f };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var merged0: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4f };
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut; out.pos = vec4f(p[vi], 0.0, 1.0); return out;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let dims = i32(cfg.params.x);
  let pixel = in.pos.xy - vec2f(0.5);
  let base = vec2i(pixel * f32(dims));
  var radiance = vec4f(0.0);
  for (var y = 0; y < 8; y++) {
    if (y >= dims) { break; }
    for (var x = 0; x < 8; x++) {
      if (x >= dims) { break; }
      radiance += textureLoad(merged0, base + vec2i(x, y), 0);
    }
  }
  return radiance / f32(dims * dims);
}
