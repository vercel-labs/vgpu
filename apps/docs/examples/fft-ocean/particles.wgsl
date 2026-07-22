import { ParticleUniforms, VertexOut } from "./particles-common.wgsl";

@group(0) @binding(0) var<uniform> u: ParticleUniforms;
@group(0) @binding(1) var u_displacement: texture_2d<f32>;
@group(0) @binding(2) var u_normalFoam: texture_2d<f32>;


fn quadCorner(vertexIndex: u32) -> vec2f {
  let cornerIndex = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u)[vertexIndex % 6u];
  switch (cornerIndex) {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f( 1.0, -1.0); }
    case 2u: { return vec2f(-1.0,  1.0); }
    default: { return vec2f( 1.0,  1.0); }
  }
}

@vertex fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOut {
  // --- Particle indexing and texel selection ---------------------------------------
  let resolution = max(1u, u32(u.viewport.w));
  let i = instanceIndex % resolution;
  let j = instanceIndex / resolution;
  let particleRef = vec2f(f32(i), f32(j)) / f32(resolution);
  let texCoord = vec2u(i, j);

  // --- Simulation data sampling -----------------------------------------------------
  let disp = textureLoad(u_displacement, texCoord, 0).xyz * u.misc.x;
  let nf = textureLoad(u_normalFoam, texCoord, 0);

  // --- World position construction --------------------------------------------------
  let halfWorld = u.simulation.x * 0.5;
  let base = vec3f(particleRef.x * u.simulation.x - halfWorld, 0.0, particleRef.y * u.simulation.x - halfWorld);
  let pos = base + disp;

  // --- Camera space conversion and distance-based fading ----------------------------
  let mv = u.view * vec4f(pos, 1.0);
  let viewDir = -mv.xyz;
  let dist = -mv.z;
  let f = 1.0 - smoothstep(u.fade.x, u.fade.y, dist);
  let fade = pow(clamp(f, 0.0, 1.0), u.fade.z);

  // --- Continuous projection ---------------------------------------------------------
  let projected = u.projection * mv;
  let ndc = projected.xy / projected.w;

  // --- Point size in clip space -----------------------------------------------------
  let corner = quadCorner(vertexIndex);
  let pointSizePx = 2.0 * u.misc.y * u.viewport.z;
  let clipOffset = corner * (pointSizePx / u.viewport.xy) * projected.w;
  let clip = vec4f(ndc * projected.w + clipOffset, projected.z, projected.w);

  // --- Attribute packing for the fragment shader ------------------------------------
  var out: VertexOut;
  out.position = clip;
  out.pointCoord = corner * 0.5 + vec2f(0.5);
  out.foam = nf.w;
  out.normal = nf.xyz;
  out.viewDir = viewDir;
  out.height = disp.y;
  out.fade = fade;
  return out;
}

// Fragment color composition summary:
//   Base = u.oceanColor * 0.5 (baseline brightness)
//   + WHITE LAYER (crest) = u.neonColor * crest * 0.5
//   + WHITE LAYER (fresnel) = u.neonColor * fresnel * 0.15
//   Result is mixed toward u.foamColor by foam amount, then dimmed by fade.
//   High-intensity outputs feed the downstream bloom pass, so bright "white layers"
//   directly influence bloom strength.
@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // --- Circular sprite mask ---------------------------------------------------------
  let cc = in.pointCoord - vec2f(0.5);
  let d2 = dot(cc, cc);
  if (d2 > 0.25) {
    discard;
  }

  // --- Lighting inputs --------------------------------------------------------------
  let n = normalize(in.normal);
  let v = normalize(in.viewDir);
  let fresnel = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);

  // --- Foam and crest masks ---------------------------------------------------------
  let foam = clamp(in.foam, 0.0, 1.0);
  let crest = smoothstep(-0.5, 1.5, in.height);

  // --- Neon override mode -----------------------------------------------------------
  if (u.misc.z > 0.5) {
    let lc = mix(u.neonColor.rgb, u.foamColor.rgb, foam);
    var a = 0.06 + crest * 0.42 + fresnel * 0.12;
    a = mix(a, 0.9, foam);
    a *= in.fade;
    // Bright neon particles go straight to the bloom pass via this color output.
    return vec4f(lc, clamp(a, 0.0, 1.0));
  }

  // --- Base ocean contribution ------------------------------------------------------
  var color = u.oceanColor.rgb * 0.5; // WHITE LAYER: baseline ocean brightness.

  // --- Crest highlight --------------------------------------------------------------
  color += u.neonColor.rgb * crest * 0.5; // WHITE LAYER: brightens foamy peaks.

  // --- Fresnel rim lighting ---------------------------------------------------------
  color += u.neonColor.rgb * fresnel * 0.15; // WHITE LAYER: view-dependent glow.

  // --- Foam mix (drives particles toward pure white) --------------------------------
  color = mix(color, u.foamColor.rgb, foam); // WHITE LAYER: replaces color with foam white.

  // --- Alpha stack (more opaque where bright layers exist) --------------------------
  var alpha = 0.02 + crest * 0.06 + fresnel * 0.04;
  alpha = mix(alpha, 1.0, foam);

  // --- View fade attenuation --------------------------------------------------------
  color *= in.fade;
  alpha *= in.fade;

  // Bloom sees this final color; brighter whites trigger stronger bloom response.
  return vec4f(color, clamp(alpha, 0.0, 1.0));
}
