struct Uniforms {
  resolution: vec2f,
  grid: vec2f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dye: array<vec4f>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let grid = vec2u(uniforms.grid);
  let pixel = min(vec2u(floor(uv * uniforms.grid)), grid - vec2u(1u));
  return dye[pixel.y * grid.x + pixel.x];
}
