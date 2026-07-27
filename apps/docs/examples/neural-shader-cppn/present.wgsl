// Presents the network output directly from the buffer ONNX Runtime Web wrote.
//
// The bound storage buffer is either the wrapped ORT output (browser) or the CPU
// evaluator's upload (thumbnail); both are NHWC float32 RGBA at GRID x GRID, so
// this shader is the single presentation path.
//
// Placeholder aesthetics: straight bilinear sampling with no grading. The visual
// owner replaces the body of `fs_main` and may add uniforms.
struct Uniforms {
  resolution: vec2f,
  grid: f32,
  time: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> pixels: array<vec4f>;

fn texel(x: i32, y: i32) -> vec3f {
  let size = i32(uniforms.grid);
  let cx = clamp(x, 0, size - 1);
  let cy = clamp(y, 0, size - 1);
  return pixels[cy * size + cx].rgb;
}

/// Manual bilinear sample of the network image; avoids any texture upload.
fn sample_network(uv: vec2f) -> vec3f {
  let grid = uv * uniforms.grid - 0.5;
  let base = floor(grid);
  let f = grid - base;
  let x = i32(base.x);
  let y = i32(base.y);
  let bottom = mix(texel(x, y), texel(x + 1, y), f.x);
  let top = mix(texel(x, y + 1), texel(x + 1, y + 1), f.x);
  return mix(bottom, top, f.y);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // Aspect-fill (cover) the square network image: the long axis spans the whole
  // image and the short axis is cropped symmetrically, so pixels stay square.
  let span = uniforms.resolution / max(uniforms.resolution.x, uniforms.resolution.y);
  let uv = (position.xy / uniforms.resolution - 0.5) * span + 0.5;
  return vec4f(sample_network(clamp(uv, vec2f(0.0), vec2f(1.0))), 1.0);
}
