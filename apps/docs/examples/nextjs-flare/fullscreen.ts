const TOP_LEFT_FULLSCREEN_VERTEX = /* wgsl */ `
struct FlareFullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn flare_fullscreen_vs(@builtin(vertex_index) vertexIndex: u32) -> FlareFullscreenVertexOut {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  // WebGPU textures and external rasters are top-row-first. Emit top-left UVs
  // once here so external input and every intermediate target share one space.
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var output: FlareFullscreenVertexOut;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}
`;

// Bundler `.wgsl` imports arrive as `{ version, wgsl }` shader-source modules
// even though the ambient `*.wgsl` type declares a string; unwrap both shapes
// before prepending the shared vertex stage.
export function withTopLeftFullscreen(fragmentShader: string): string {
  const source =
    typeof fragmentShader === 'string'
      ? fragmentShader
      : (fragmentShader as unknown as { wgsl: string }).wgsl;
  return `${TOP_LEFT_FULLSCREEN_VERTEX}\n${source}`;
}
