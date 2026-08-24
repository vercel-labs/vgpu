struct Scene {
  view_projection: mat4x4f,
  spin: f32,
  // Width / height of the decoded picture, used to centre-crop it onto square faces.
  video_aspect: f32,
  tilt: f32,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var video_tex: texture_2d<f32>;
@group(0) @binding(2) var video_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
};

fn rotate(p: vec3f) -> vec3f {
  let cy = cos(scene.spin);
  let sy = sin(scene.spin);
  let spun = vec3f(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  let cx = cos(scene.tilt);
  let sx = sin(scene.tilt);
  return vec3f(spun.x, cx * spun.y - sx * spun.z, sx * spun.y + cx * spun.z);
}

/**
 * The unit cube ships position and normal only, so the face parametrization is
 * derived here: pick the two axes the face does not point along, and flip them so
 * the picture reads upright and unmirrored from outside the cube.
 */
fn face_uv(p: vec3f, n: vec3f) -> vec2f {
  let a = abs(n);
  if (a.x > 0.5) {
    return vec2f(-sign(n.x) * p.z, -p.y) + vec2f(0.5);
  }
  if (a.y > 0.5) {
    return vec2f(p.x, sign(n.y) * p.z) + vec2f(0.5);
  }
  return vec2f(sign(n.z) * p.x, -p.y) + vec2f(0.5);
}

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = scene.view_projection * vec4f(rotate(position), 1.0);
  out.uv = face_uv(position, normal);
  out.normal = rotate(normal);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Cover, not stretch: a 16:9 frame keeps its proportions and the square face
  // shows the middle of it.
  let scale = select(vec2f(1.0, scene.video_aspect), vec2f(1.0 / scene.video_aspect, 1.0), scene.video_aspect > 1.0);
  let uv = vec2f(0.5) + (in.uv - vec2f(0.5)) * scale;
  var color = textureSample(video_tex, video_samp, uv).rgb;

  // Enough shading to read the cube as a solid: a soft key light plus a thin
  // darkening at the face borders so adjacent faces never merge.
  let n = normalize(in.normal);
  let key = 0.72 + 0.28 * max(dot(n, normalize(vec3f(-0.35, 0.8, 0.9))), 0.0);
  let border = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
  let inset = smoothstep(0.0, 0.02, border);
  color = color * key * mix(0.35, 1.0, inset);

  return vec4f(color, 1.0);
}
