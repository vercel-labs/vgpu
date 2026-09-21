struct Params {
  light: vec2f,
  aspect: vec2f,
  logoCenter: vec2f,
  flareColor: vec3f,
  rimIntensity: f32,
  extension: f32,
  beamIntensity: f32,
  filmGrain: f32,
  smoothness: f32,
  logoOpacity: f32,
  frameIndex: u32,
  spotFocus: f32,
  scatter: f32,
  rimFill: f32,
  verticalEdgeFade: f32,
}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var rimTexture: texture_2d<f32>;
@group(0) @binding(3) var rimBlurTexture: texture_2d<f32>;
@group(0) @binding(4) var blueNoiseTexture: texture_2d<f32>;
@group(0) @binding(5) var<uniform> params: Params;

fn resolveDarkColor(radiance: vec3f) -> vec3f {
  return max(vec3f(0.0), vec3f(1.0) - exp(-radiance * 1.3));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSample(sceneTexture, linearSampler, uv).r;
  let rimSample = textureSample(rimTexture, linearSampler, uv).r;
  let rimBlur = textureSample(rimBlurTexture, linearSampler, uv).r;
  let direction = uv - params.light;
  let decay = mix(0.85, 0.975, params.extension);
  let density = mix(0.35, 1.15, params.extension);
  let delta = direction * (density / 48.0);
  let dimensions = textureDimensions(rimTexture);
  let pixel = vec2u(clamp(uv * vec2f(dimensions), vec2f(0.0), vec2f(dimensions) - vec2f(1.0)));
  let offset = vec2u(params.frameIndex * 73u, params.frameIndex * 23u);
  let noisePixel = (pixel + offset) & vec2u(127u);
  let blueNoise = textureLoad(blueNoiseTexture, vec2i(noisePixel), 0).r;
  let jitter = fract(blueNoise + f32(params.frameIndex) * 0.61803398875);
  var coordinate = uv - delta * jitter * params.smoothness;
  var illumination = 1.0;
  var illuminationSum = 0.0;
  var rimRays = 0.0;
  for (var i = 0; i < 48; i++) {
    coordinate -= delta;
    let sharpRay = textureSample(rimTexture, linearSampler, coordinate).r;
    let blurredRay = textureSample(rimBlurTexture, linearSampler, coordinate).r;
    rimRays += mix(sharpRay, blurredRay, params.smoothness) * illumination;
    illuminationSum += illumination;
    illumination *= decay;
  }
  // Preserve the extension=1 energy while allowing extension to control reach.
  rimRays = rimRays / max(illuminationSum, 0.001) * 4.102966;

  let haloDelta = (uv - params.light) * params.aspect;
  let haloRadius = mix(0.05, 0.6, params.spotFocus);
  let halo = exp(-dot(haloDelta, haloDelta) / (haloRadius * haloRadius));
  let lineCoverage = max(scene, rimBlur * 0.65);
  let haloLine = halo * lineCoverage * params.rimIntensity * 1.1;
  let spot = max(rimSample, rimBlur * 0.85 * params.rimFill) * (1.0 + halo * 1.5);
  let scatterSignal = rimRays * params.beamIntensity * params.scatter;

  var radiance = params.flareColor * haloLine;
  radiance += vec3f(scene) * params.logoOpacity * 0.22;
  radiance += mix(vec3f(1.0), params.flareColor, 0.5) * spot * params.rimIntensity;
  radiance += params.flareColor * spot * 0.4 * params.rimIntensity;
  radiance += params.flareColor * scatterSignal;

  let radialMask = smoothstep(1.35, 0.25, length((uv - params.logoCenter) * params.aspect));
  let color = resolveDarkColor(radiance * radialMask);
  let beamSignal = scatterSignal * radialMask;
  let verticalFadeWidth = max(params.verticalEdgeFade, 0.0001);
  let horizontalFadeWidth = verticalFadeWidth * params.aspect.y / max(params.aspect.x, 0.0001);
  let verticalEdgeMask = smoothstep(0.0, verticalFadeWidth, uv.y) * smoothstep(0.0, verticalFadeWidth, 1.0 - uv.y);
  let horizontalEdgeMask = smoothstep(0.0, horizontalFadeWidth, uv.x) *
    smoothstep(0.0, horizontalFadeWidth, 1.0 - uv.x);
  let edgeMask = verticalEdgeMask * horizontalEdgeMask;
  let composed = mix(vec3f(0.0), color, edgeMask);

  // A decorrelated blue-noise layer masks sparse ray-march structure only in
  // dim and mid scattering, leaving the logo and flat background untouched.
  let grainOffset = vec2u(params.frameIndex * 37u + 53u, params.frameIndex * 109u + 17u);
  let grainPixel = (pixel * vec2u(3u, 5u) + grainOffset) & vec2u(127u);
  let grainSample = textureLoad(blueNoiseTexture, vec2i(grainPixel), 0).r;
  let grain = (fract(grainSample + f32(params.frameIndex) * 0.61803398875 + 0.38196601125) - 0.5) * 2.0;
  let beamGate = smoothstep(0.003, 0.05, beamSignal) * (1.0 - smoothstep(0.4, 1.0, beamSignal));
  let logoCoverage = max(scene, max(rimSample, rimBlur));
  let grainMask = beamGate * (1.0 - smoothstep(0.02, 0.3, logoCoverage)) * edgeMask;
  let grained = clamp(composed + vec3f(grain * params.filmGrain * grainMask), vec3f(0.0), vec3f(1.0));
  return vec4f(grained, 1.0);
}
