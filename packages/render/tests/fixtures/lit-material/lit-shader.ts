export const UNIFORM_OFFSET_VIEW_PROJECTION = 0;
export const UNIFORM_OFFSET_MODEL = 64;
export const UNIFORM_OFFSET_CAMERA_POSITION = 128;
export const UNIFORM_OFFSET_LIGHT_DIRECTION = 144;
export const UNIFORM_OFFSET_LIGHT_COLOR = 160;
export const UNIFORM_OFFSET_LIGHT_INTENSITY = 172;
export const UNIFORM_OFFSET_BASE_COLOR = 192;
export const UNIFORM_OFFSET_METALLIC = 204;
export const UNIFORM_OFFSET_ROUGHNESS = 208;
export const litUniformsByteSize = 224;

export const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = Object.freeze({
  arrayStride: 24,
  attributes: Object.freeze([
    Object.freeze({ shaderLocation: 0, offset: 0, format: "float32x3" as const }),
    Object.freeze({ shaderLocation: 1, offset: 12, format: "float32x3" as const }),
  ]),
});

export const LIT_SHADER_SOURCE = /* wgsl */ `
struct Uniforms {
  viewProjectionMatrix: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  lightDirection: vec3<f32>,
  lightColor: vec3<f32>,
  lightIntensity: f32,
  _padAfterLight: vec3<f32>,
  baseColor: vec3<f32>,
  metallic: f32,
  roughness: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};
struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
};

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  let worldPos = uniforms.modelMatrix * vec4<f32>(in.position, 1.0);
  // Normal transform assumes uniform scale; non-uniform scale needs transpose(inverse(modelMatrix)).
  let worldNormal = (uniforms.modelMatrix * vec4<f32>(in.normal, 0.0)).xyz;
  var out: VertexOut;
  out.clipPosition = uniforms.viewProjectionMatrix * worldPos;
  out.worldPosition = worldPos.xyz;
  out.worldNormal = worldNormal;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let N = normalize(in.worldNormal);
  // Direction-of-travel convention: light.direction points where the photons go.
  // The vector FROM surface TO light source is therefore -light.direction.
  let L = normalize(-uniforms.lightDirection);
  let V = normalize(uniforms.cameraPosition - in.worldPosition);
  let H = normalize(L + V);

  let NdotL = max(dot(N, L), 0.0);
  let NdotH = max(dot(N, H), 0.0);

  // Lambertian diffuse, attenuated by (1 - metallic) so metals lose diffuse.
  let diffuse = uniforms.baseColor * (1.0 - uniforms.metallic) * NdotL;

  // Simple Blinn-Phong-style specular term.
  // Specular tint: dielectrics use a fixed white-ish F0; metals use baseColor.
  let f0 = mix(vec3<f32>(0.04), uniforms.baseColor, uniforms.metallic);
  // Roughness -> exponent: rougher = lower exponent. Map [0,1] -> [128, 1].
  let shininess = mix(128.0, 1.0, uniforms.roughness);
  let specular = f0 * pow(NdotH, shininess);

  let lightContrib = uniforms.lightColor * uniforms.lightIntensity;
  let ambient = uniforms.baseColor * 0.03;
  let color = ambient + (diffuse + specular) * lightContrib;
  return vec4<f32>(color, 1.0);
}
`;
