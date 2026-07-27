// The cube's exit surface, rendered on its own before the glass pass: back faces only,
// storing the outward world normal in rgb and the camera distance in a. Sampling it at
// the front fragment's own pixel is what turns one refraction into two — the ray bends
// entering the glass and again on the way out, which is where a cube stops looking like a
// coloured window and starts looking solid.
struct Backface {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
};
@group(0) @binding(0) var<uniform> backface: Backface;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world_position: vec3f,
  @location(1) world_normal: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  let world = backface.model * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = backface.view_projection * world;
  out.world_position = world.xyz;
  // `model` is rotation-only, so the normal needs no inverse-transpose.
  out.world_normal = (backface.model * vec4f(normal, 0.0)).xyz;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // The draw culls front faces, so every fragment here is the far side of the cube; the
  // normal still points out of the solid, which is the convention `glass.wgsl` refracts
  // against. The cube is convex, so exactly one back face covers each pixel and the pass
  // needs no depth buffer of its own.
  return vec4f(normalize(in.world_normal), distance(in.world_position, backface.camera_position));
}
