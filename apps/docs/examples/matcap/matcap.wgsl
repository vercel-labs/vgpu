struct Uniforms {
  view_projection: mat4x4f,
  view: mat4x4f,
  yaw: f32,
  pitch: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var matcap_tex: texture_2d<f32>;
@group(0) @binding(2) var matcap_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local_position: vec3f,
  @location(1) normal: vec3f,
};

// Spinning on the CPU would mean a model matrix; two angles and a rotation are
// enough here, and they keep the uniform block to one small struct.
fn rotate(p: vec3f) -> vec3f {
  let cy = cos(uniforms.yaw);
  let sy = sin(uniforms.yaw);
  let yawed = vec3f(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  let cx = cos(uniforms.pitch);
  let sx = sin(uniforms.pitch);
  return vec3f(yawed.x, cx * yawed.y - sx * yawed.z, sx * yawed.y + cx * yawed.z);
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.view_projection * vec4f(rotate(position), 1.0);
  // The relief is carved in object space, so the pattern stays fixed to the
  // surface and travels with the spin. Both the position and the untransformed
  // normal are handed over in that same space, and the fragment stage rotates
  // only after the perturbation is applied.
  out.local_position = position;
  out.normal = normal;
  return out;
}

// Height field the relief is derived from. Three axis-aligned lobes fold into a
// pattern with no visible seam or pole.
fn relief(p: vec3f) -> f32 {
  let waves = sin(p.x * 7.0) * sin(p.y * 7.0) * sin(p.z * 7.0);
  return waves * 0.5 + sin(p.y * 3.0 + waves * 1.4) * 0.5;
}

// A smooth ball would sample the same texel forever as it turns, hiding the
// rotation entirely. Tilting the normal by the height field's gradient makes
// the lookup move, which is what puts the matcap's behavior on screen.
fn perturbed_normal(local_position: vec3f, normal: vec3f) -> vec3f {
  let epsilon = 0.012;
  let gradient = vec3f(
    relief(local_position + vec3f(epsilon, 0.0, 0.0)) - relief(local_position - vec3f(epsilon, 0.0, 0.0)),
    relief(local_position + vec3f(0.0, epsilon, 0.0)) - relief(local_position - vec3f(0.0, epsilon, 0.0)),
    relief(local_position + vec3f(0.0, 0.0, epsilon)) - relief(local_position - vec3f(0.0, 0.0, epsilon)),
  ) / (2.0 * epsilon);
  // Only the part of the gradient along the surface bends the normal; the
  // component along it would just push in and out without tilting anything.
  let tangential = gradient - normal * dot(gradient, normal);
  return normalize(normal - tangential * 0.055);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = perturbed_normal(in.local_position, normalize(in.normal));
  // The entire lighting model: put the normal in view space and read the
  // matching texel of the baked ball. No lights, no BRDF, one fetch.
  let view_normal = normalize((uniforms.view * vec4f(rotate(normal), 0.0)).xyz);
  // 0.49 rather than 0.5 keeps the fetch inside the disk, so the unlit corners
  // can never bleed in along the silhouette.
  let uv = vec2f(view_normal.x, -view_normal.y) * 0.49 + vec2f(0.5);
  return textureSample(matcap_tex, matcap_samp, uv);
}
