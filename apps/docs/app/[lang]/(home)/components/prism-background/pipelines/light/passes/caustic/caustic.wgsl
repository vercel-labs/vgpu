import { Scene } from "../../../../scene/scene.wgsl";
import { beamWidthReveal } from "../../../shared/spectral/beam-reveal.wgsl";
import { decodeLightVertex } from "../../../shared/spectral/light-vertex.wgsl";
import { spectralSampleAt } from "../../../shared/spectral/spectral.wgsl";
import {
  evaluateWallNormalsLevel,
  wallNormalTextureLod,
} from "../wall/wall-normal.wgsl";

struct CausticParams {
  strength: f32,
  coverage: f32,
  farDesaturation: f32,
  farBrightness: f32,
  travelScale: f32,
  falloffRateScale: f32,
  falloffPowerScale: f32,
  materialWorldScale: f32,
  normalStrength: f32,
  microNormalFrequency: f32,
  microNormalStrength: f32,
  normalInfluence: f32,
  normalElevation: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> caustic: CausticParams;
@group(0) @binding(2) var causticProfile: texture_2d<f32>;
@group(0) @binding(3) var causticSampler: sampler;
@group(0) @binding(4) var wallMaterial: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) profile: f32,
  @location(2) intensity: f32,
  @location(3) travel: f32,
  @location(4) wavelength: f32,
  @location(5) worldPosition: vec2f,
  @location(6) revealProfile: f32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec2f,
  @location(3) rawIntensity: f32,
) -> VertexOut {
  var out: VertexOut;
  // One continuous physical cross-section must keep one depth. Putting the
  // exterior rays on the wall and the interior rays inside the glass makes the
  // shared entry/exit vertices project to different pixels under perspective.
  out.position = scene.viewProjection * vec4f(position, scene.lightPlaneZ, 1.0);
  let metadata = decodeLightVertex(
    vertexIndex,
    scene.lightWhiteQuads,
    scene.lightBeamSlices,
    scene.lightInternalQuads,
    scene.lightInternalSegments,
  );
  out.color = vec3f(1.0);
  out.wavelength = -1.0;
  // Empty quads carry a negative intensity sentinel and never fetch the LUT.
  if metadata.white == 0u && rawIntensity >= 0.0 {
    let spectral = spectralSampleAt(
      metadata.spectralIndex,
      scene.lightSpectralSamples,
    );
    out.color = spectral.rgb;
    out.wavelength = spectral.a;
  }
  out.profile = metadata.profile;
  out.intensity = max(rawIntensity, 0.0);
  out.travel = metadata.travel;
  out.worldPosition = position;
  out.revealProfile = metadata.revealProfile;
  return out;
}

fn wallNormalResponse(in: VertexOut) -> f32 {
  // Derivatives must be evaluated uniformly. Explicit-LOD samples below can
  // then stay inside the exterior-only branch without sampling the dense
  // internal spectral mesh.
  let normalLod = wallNormalTextureLod(
    in.worldPosition,
    caustic.materialWorldScale,
    wallMaterial,
  );
  let travelGradient = vec2f(dpdx(in.travel), dpdy(in.travel));
  let worldPositionDx = dpdx(in.worldPosition);
  let worldPositionDy = dpdy(in.worldPosition);
  let hasTravelGradient = dot(travelGradient, travelGradient) > 0.000000000001;
  // Only the dispersed exterior cells carry both a wavelength and increasing
  // travel. White light has a negative wavelength; internal spectral strips
  // keep travel constant at zero.
  let isExteriorRainbow = in.wavelength >= 0.0 && hasTravelGradient;
  if (!isExteriorRainbow || caustic.normalInfluence <= 0.0) {
    return 1.0;
  }

  let worldTravel = worldPositionDx * travelGradient.x
    + worldPositionDy * travelGradient.y;
  var rayDirection = normalize(scene.inputBeamDirection);
  if (hasTravelGradient && dot(worldTravel, worldTravel) > 0.000000000001) {
    rayDirection = normalize(worldTravel);
  }

  let elevation = clamp(caustic.normalElevation, 1.0, 89.0)
    * 0.01745329252;
  // The baked wall normals use the projected incident-vector convention.
  // Negating this tangent swaps lit ridges and cavities along the beam.
  let incidentLight = normalize(vec3f(
    rayDirection * cos(elevation),
    sin(elevation),
  ));
  let normal = evaluateWallNormalsLevel(
    in.worldPosition,
    caustic.materialWorldScale,
    caustic.normalStrength,
    caustic.microNormalFrequency,
    caustic.microNormalStrength,
    normalLod,
    wallMaterial,
    causticSampler,
  ).combined;
  let flatResponse = max(incidentLight.z, 0.05);
  let relativeResponse = clamp(
    max(dot(normal, incidentLight), 0.0) / flatResponse,
    0.0,
    2.5,
  );
  return mix(
    1.0,
    relativeResponse,
    clamp(caustic.normalInfluence, 0.0, 1.0),
  );
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let radius = abs(in.profile);
  let radial = exp(-scene.lightEdgeFalloff * radius * radius)
    * (1.0 - smoothstep(0.55, 1.0, radius));
  let widthReveal = beamWidthReveal(
    in.revealProfile,
    scene.beamWidthReveal,
  );
  let distance = clamp(in.travel / max(caustic.travelScale, 0.001), 0.0, 1.0);
  let wavelengthUv = clamp((700.0 - max(in.wavelength, 400.0)) / 300.0, 0.0, 1.0);
  let baked = textureSample(causticProfile, causticSampler, vec2f(distance, wavelengthUv));
  let outgoingFalloff = 1.0 / pow(
    1.0
      + max(scene.rainbowFalloffRate, 0.0)
        * max(caustic.falloffRateScale, 0.0)
        * max(in.travel, 0.0),
    max(
      scene.rainbowFalloffPower * max(caustic.falloffPowerScale, 0.0),
      0.0001,
    ),
  );
  let surfaceResponse = wallNormalResponse(in);
  let energy = max(in.intensity, 0.0) * radial * widthReveal * outgoingFalloff
    * max(scene.lightOpacity, 0.0) * baked.a;
  let bounded = 1.0 - exp(-energy * max(caustic.strength, 0.0));
  let farMix = smoothstep(0.16, 0.92, distance) * caustic.farDesaturation;
  let spectral = in.color * mix(vec3f(1.0), baked.rgb, select(0.34, 0.0, in.wavelength < 0.0));
  let neutral = vec3f(max(max(spectral.r, spectral.g), spectral.b) + caustic.farBrightness * distance);
  let tint = clamp(mix(spectral, neutral, farMix) * (0.62 + bounded * 0.68), vec3f(0.0), vec3f(1.45));
  let coverage = clamp(bounded * caustic.coverage, 0.0, 1.0);
  // The wall has already been shaded. Emit premultiplied radiance with zero
  // alpha into an additive draw so no wavelength can darken the plaster below.
  return vec4f(tint * coverage * surfaceResponse, 0.0);
}
