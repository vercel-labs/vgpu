import {
  ParticleUniforms,
  VertexOut,
  crestMask,
  foamMask,
  fresnelTerm,
  particleVertex,
  screenFade,
  spriteMaskDiscard,
} from "./particles-common.wgsl";

const LIGHT_ALPHA_BASE: f32 = 0.06;
const LIGHT_ALPHA_CREST: f32 = 0.18;
const LIGHT_ALPHA_FRESNEL: f32 = 0.12;
const LIGHT_ALPHA_FOAM: f32 = 0.85;

@group(0) @binding(0) var<uniform> u: ParticleUniforms;
@group(0) @binding(1) var u_displacement: texture_2d<f32>;
@group(0) @binding(2) var u_normalFoam: texture_2d<f32>;

@vertex fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOut {
  return particleVertex(u, u_displacement, u_normalFoam, vertexIndex, instanceIndex);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  if (spriteMaskDiscard(in.pointCoord)) {
    discard;
  }

  let fresnel = fresnelTerm(in.normal, in.viewDir);
  let crest = crestMask(in.height);
  let foam = foamMask(in.foam);

  var alpha = LIGHT_ALPHA_BASE + crest * LIGHT_ALPHA_CREST + fresnel * LIGHT_ALPHA_FRESNEL;
  alpha = mix(alpha, LIGHT_ALPHA_FOAM, foam);
  alpha *= in.fade * screenFade(in.position, u.viewport.xy);

  return vec4f(0.0, 0.0, 0.0, clamp(alpha, 0.0, 1.0));
}
