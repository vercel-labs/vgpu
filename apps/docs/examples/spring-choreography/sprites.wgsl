// Expands each particle into a capsule from its tail to its head: a round
// spark at rest, a streak while the spring carries it. The streak keeps the
// spark's energy (spread over its length) and brightens towards the head.
// Additive blending stacks them into the HDR scene.

struct Particle {
  ndc: vec2f,
  streak: vec2f,
  color: vec3f,
  size: f32,
}

struct View {
  resolution: vec2f,
  // 1 - trail persistence, so a still swarm keeps its brightness with trails on.
  gain: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> view: View;

struct VertexOut {
  @builtin(position) position: vec4f,
  // Pixels along the axis (head at +length / 2) and across it.
  @location(0) local: vec2f,
  // Constant across a spark; not flat, which compatibility mode rejects.
  @location(1) shape: vec2f,
  @location(2) color: vec3f,
}

@vertex fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  // Triangle-strip order.
  var quad = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let corner = quad[vertex];
  let particle = particles[instance];
  var out: VertexOut;
  if (particle.size <= 0.0) {
    out.position = vec4f(2.0, 2.0, 0.0, 1.0);
    return out;
  }
  let halfResolution = view.resolution * 0.5;
  let streak = particle.streak * halfResolution;
  let span = length(streak);
  let axis = select(vec2f(1.0, 0.0), streak / max(span, 1e-4), span > 0.25);
  let normal = vec2f(-axis.y, axis.x);
  // Sub-pixel sparks are drawn at one pixel and dimmed, so they neither alias nor vanish.
  let radius = max(particle.size, 1.0) * 0.5;
  let reach = radius + 1.0;
  let halfLength = span * 0.5;
  let center = particle.ndc * halfResolution - streak * 0.5;
  let local = vec2f(corner.x * (halfLength + reach), corner.y * reach);
  let pixel = center + axis * local.x + normal * local.y;
  out.position = vec4f(pixel / halfResolution, 0.0, 1.0);
  out.local = local;
  out.shape = vec2f(halfLength, radius);
  let coverage = min(particle.size, 1.0);
  out.color = particle.color * view.gain * coverage * radius / (radius + halfLength);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let halfLength = in.shape.x;
  let radius = in.shape.y;
  let along = clamp(in.local.x, -halfLength, halfLength);
  let gap = length(vec2f(in.local.x - along, in.local.y));
  let falloff = gap / (radius + 0.5);
  let core = exp(-falloff * falloff * 2.2);
  if (core < 0.004) {
    discard;
  }
  // 0 at the tail, 1 at the head.
  let toward = select(1.0, along / halfLength * 0.5 + 0.5, halfLength > 0.1);
  let ramp = 0.3 + 0.7 * toward * toward;
  return vec4f(in.color * ramp, core);
}
