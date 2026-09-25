// Tiny air bubbles riding in the glass: a thin ring, a small highlight and a
// soft shadow inside the ring. One instanced quad per bubble, drawn over the
// lit scene in the shading pass, so only the pixels around a bubble pay for it.
// The blend keeps dst × (1 − a) + rgb, weighted by how much of the layer the
// bubble rides in covers the pixel.

struct Layer {
  viewport: vec2f,
  dpr: f32,
  gridDim: f32,
  panelLift: f32,
  // centre.xy, radius (CSS px), alpha; a negative alpha rides on the top layer.
  bubbles: array<vec4f, 28>,
}

@group(0) @binding(0) var fieldTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> layer: Layer;

const WHITE = vec3f(0.93, 0.96, 1.0);
// The quad reaches this far (CSS px) past the ring for its antialiasing.
const MARGIN = 3.0;

struct Varyings {
  @builtin(position) position: vec4f,
  // From the bubble centre, CSS px.
  @location(0) offset: vec2f,
  // CSS px on the page, for the field lookup.
  @location(1) page: vec2f,
  // radius, alpha: the same at every corner.
  @location(2) bubble: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let bubble = layer.bubbles[instance];
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u)) * 2.0 - 1.0;
  let offset = corner * (bubble.z + MARGIN);
  let page = bubble.xy + offset;
  let ndc = vec2f(page.x / layer.viewport.x * 2.0 - 1.0, 1.0 - page.y / layer.viewport.y * 2.0);
  return Varyings(vec4f(ndc, 0.0, 1.0), offset, page, bubble.zw);
}

fn band(x: f32, centre: f32, width: f32) -> f32 {
  let u = (x - centre) / width;
  return exp(-u * u);
}

fn coverage(d: f32) -> f32 {
  return clamp(0.5 - d * layer.dpr, 0.0, 1.0);
}

@fragment fn fs_main(in: Varyings) -> @location(0) vec4f {
  let radius = in.bubble.x;
  let alpha = in.bubble.y;
  let dist = length(in.offset);
  let ring = band(dist, radius, max(0.45, 0.7 / layer.dpr));
  let spot = band(length(in.offset + radius * vec2f(0.4, 0.45)), 0.0, 0.28 * radius + 0.3);
  let shadow = 0.3 * band(dist, radius - 1.3, 0.7);

  let field = textureSampleLevel(fieldTex, samp, in.page / layer.viewport, 0.0);
  let panel = coverage(field.g) * layer.panelLift;
  let grid = coverage(field.r) * mix(1.0, 0.62, layer.gridDim) * (1.0 - panel);
  let weight = select(panel, grid, alpha > 0.0) * abs(alpha);
  return vec4f(WHITE * (ring * 0.42 + spot * 0.55) * weight, shadow * weight);
}
