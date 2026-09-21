// Draws the atmosphere's back-facing shell over the planet.

import { saturate, valueRemap } from "./planet-common.wgsl";

const ATMOSPHERE_COLOR = vec3f(0.51, 0.714, 1.0);
const SUNSET_COLOR = vec3f(1.0, 0.373, 0.349);

struct AtmosphereUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  strength: f32,
  lightDirection: vec3f,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereUniforms;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.world = input.position;
  out.normal = input.normal;
  out.clip = atmosphere.viewProjection * vec4f(input.position, 1.0);
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let viewDirection = normalize(atmosphere.cameraPosition - input.world);
  if (dot(normal, viewDirection) > 0.0) {
    discard;
  }

  let lightDirection = normalize(atmosphere.lightDirection);
  let sunLight = saturate(valueRemap(dot(normal, lightDirection), 0.0, 0.2, 0.0, 1.0));

  var fresnel = saturate(valueRemap(dot(-normal, viewDirection), 0.0, 0.25, 0.0, 1.0));
  fresnel = pow(fresnel, 4.0);

  let sunsetFactor = saturate(valueRemap(dot(-lightDirection, viewDirection), 0.97, 1.0, 0.0, 1.0));
  let color = mix(ATMOSPHERE_COLOR, SUNSET_COLOR, sunsetFactor);
  return vec4f(color, fresnel * sunLight * atmosphere.strength);
}
