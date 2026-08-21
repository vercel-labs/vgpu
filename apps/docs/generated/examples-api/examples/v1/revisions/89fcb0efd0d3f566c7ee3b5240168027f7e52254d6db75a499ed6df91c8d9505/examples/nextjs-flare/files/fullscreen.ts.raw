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

// Bundler `.wgsl` imports arrive as `{ version, wgsl }` shader-source modules,
// which is exactly what the ambient `*.wgsl` declaration in `apps/docs/wgsl.d.ts`
// says (it mirrors `@vgpu/wgsl`'s own types). Accept both shapes — a hand-written
// template literal is still a plain string — and unwrap before prepending the
// shared vertex stage.
export function withTopLeftFullscreen(
  fragmentShader: string | { readonly wgsl: string },
): string {
  const source = typeof fragmentShader === 'string' ? fragmentShader : fragmentShader.wgsl;
  return `${TOP_LEFT_FULLSCREEN_VERTEX}\n${source}`;
}
