// Expands each projected star into a screen-aligned quad and shades it as a
// filtered point: a cubic-coverage core for sub-4px stars, a soft disc with
// cross rays for bright ones. Additive blending stacks them into the HDR scene.

struct Projected {
  ndc: vec2f,
  diameter: f32,
  brightness: f32,
  color: vec3f,
  opacity: f32,
  rays: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

struct View {
  resolution: vec2f,
}

@group(0) @binding(0) var<storage, read> projected: array<Projected>;
@group(0) @binding(1) var<uniform> view: View;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) diameter: f32,
  @location(2) brightness: f32,
  @location(3) color: vec3f,
  @location(4) opacity: f32,
  @location(5) rays: f32,
}

@vertex fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  var quad = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = quad[vertex];
  let star = projected[instance];
  var out: VertexOut;
  out.local = corner;
  out.diameter = star.diameter;
  out.brightness = star.brightness;
  out.color = star.color;
  out.opacity = star.opacity;
  out.rays = star.rays;
  if (star.opacity <= 0.0 || star.diameter <= 0.0) {
    // Degenerate quad off screen: nothing to rasterize.
    out.position = vec4f(2.0, 2.0, 0.0, 1.0);
    return out;
  }
  // A point sprite of `size` device pixels spans size / resolution in NDC.
  let size = max(star.diameter, 4.0);
  out.position = vec4f(star.ndc + corner * size / view.resolution, 0.0, 1.0);
  return out;
}

fn cubicCoverage(coordinate: f32) -> f32 {
  let x = abs(coordinate);
  if (x < 1.0) {
    return (4.0 - 6.0 * x * x + 3.0 * x * x * x) / 6.0;
  }
  let tail = max(2.0 - x, 0.0);
  return tail * tail * tail / 6.0;
}

fn filteredCore(pixel: vec2f, area: f32, diameter: f32) -> f32 {
  return cubicCoverage(pixel.x) * cubicCoverage(pixel.y) * area * diameter * diameter;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let diameter = in.diameter;
  let pixel = in.local * 0.5 * max(diameter, 4.0);
  let point = pixel * 2.0 / max(diameter, 0.0001);
  let distanceToCenter = length(point);
  let disc = 1.0 - smoothstep(0.08, 1.0, distanceToCenter);
  let core = pow(disc, 2.2);
  let horizontalRay = exp(-abs(point.y) * 28.0) * (1.0 - smoothstep(0.18, 1.0, abs(point.x)));
  let verticalRay = exp(-abs(point.x) * 28.0) * (1.0 - smoothstep(0.18, 1.0, abs(point.y)));
  let rays = max(horizontalRay, verticalRay) * 0.28 * in.rays;
  let resolved = smoothstep(2.0, 4.0, diameter);
  let alpha = mix(filteredCore(pixel, 0.150904, diameter), max(core, rays), resolved) * in.opacity;
  if (alpha <= 0.0) {
    discard;
  }
  let whiteCore = mix(0.59228, core, resolved) * smoothstep(0.9, 2.8, in.brightness) * 0.82;
  let colorEnergy = 1.0 - min(in.color.r, min(in.color.g, in.color.b));
  let emission = mix(in.color, vec3f(1.0), whiteCore) * in.brightness * (1.0 + colorEnergy * 0.42);
  return vec4f(emission, alpha);
}
