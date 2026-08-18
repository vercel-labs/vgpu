// The uniform block every pass shares, plus the coordinate mapping.
//
// One struct for the trace, wall and probe entry points means the estimator and
// the picture can never disagree about where the glass is or where on the wall a
// texel lands: `scene.ts` uploads this once and each pass binds the same layout.

import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";
import {
  Lamp,
  Prism,
  iorAt,
  sampleTriangle,
  stratifiedWavelength,
  traceRayWeight,
  wavelengthToLinearRgb,
} from "./optics.wgsl";

export struct Scene {
  /**
   * Camera matrix for the wall plane.
   *
   * The trace and probe passes never read it — they work in the wall's own
   * coordinates, which is why moving the camera does not invalidate the estimate
   * — but it rides in the same block so the wall cannot be drawn against a
   * different scene than the one that was traced.
   */
  viewProjection: mat4x4f,
  prismA: vec2f,
  prismB: vec2f,
  prismC: vec2f,
  lampCenter: vec2f,
  lampDirection: vec2f,
  lampRadius: f32,
  lampInnerAngle: f32,
  lampOuterAngle: f32,
  iorBase: f32,
  iorStrength: f32,
  /**
   * Half-extents of the traced rectangle — the wall — in scene units.
   *
   * `camera.ts` derives it from the frame so the wall always covers the view; the
   * trace pass and the wall's four corners read the same two numbers, which is
   * what makes the texture land on the plane at 1:1.
   */
  wallHalfExtent: vec2f,
  /** Scales the traced estimator into display range. */
  exposure: f32,
  wavelengthMin: f32,
  wavelengthMax: f32,
  /** Brightness of the analytic haze that makes the incoming beam visible. */
  haze: f32,
  /** Weight given to this frame's estimate: 1 / frames accumulated so far. */
  blend: f32,
  /** Radius of the wall pass's smoothing kernel, in caustic texels. */
  causticBlur: f32,
  raysPerFragment: u32,
  maxBounces: u32,
  /** Advances every frame so each frame draws a fresh set of rays. */
  frameIndex: u32,
  /** 1 shows the traced caustic alone, with wall, glass and haze removed. */
  causticOnly: u32,
}

export fn scenePrism(scene: Scene) -> Prism {
  return Prism(scene.prismA, scene.prismB, scene.prismC);
}

export fn sceneLamp(scene: Scene) -> Lamp {
  return Lamp(
    scene.lampCenter,
    scene.lampDirection,
    scene.lampRadius,
    scene.lampInnerAngle,
    scene.lampOuterAngle,
  );
}

/**
 * Where on the wall a point of the traced texture lands, in world coordinates.
 *
 * `uv` is top-origin, the way `effect()` hands it over and the way
 * `target.read()` gives pixels back; the room's y axis points up, so v flips.
 */
export fn scenePoint(scene: Scene, uv: vec2f) -> vec2f {
  return (uv - vec2f(0.5)) * vec2f(2.0, -2.0) * scene.wallHalfExtent;
}

export struct Ray {
  /** Point on the prism's face this ray was aimed at. */
  aim: vec2f,
  wavelength: f32,
  ior: f32,
}

/**
 * The `index`-th of this pixel's rays for this frame.
 *
 * Three decorrelated randoms: two place the point on the triangle, one jitters
 * the wavelength inside its stratum. Seeding on the pixel *and* the frame is
 * what makes the noise temporal — the same fragment aims somewhere new every
 * frame, which is the whole reason accumulating frames converges.
 */
export fn sceneRay(scene: Scene, pixel: vec2u, index: u32) -> Ray {
  let seed = pcg3d(vec3u(pixel.x, pixel.y, scene.frameIndex * scene.raysPerFragment + index));
  let wavelength = stratifiedWavelength(
    index,
    scene.raysPerFragment,
    unitFloat(seed.z),
    scene.wavelengthMin,
    scene.wavelengthMax,
  );
  return Ray(
    sampleTriangle(scenePrism(scene), unitFloat(seed.x), unitFloat(seed.y)),
    wavelength,
    iorAt(wavelength, scene.iorBase, scene.iorStrength),
  );
}

/**
 * Radiance arriving at one point of the wall, from this frame's rays alone.
 *
 * Shared by the trace pass and the probe entry point so the picture and the test
 * can never measure two different estimators.
 */
export fn estimateRadiance(scene: Scene, point: vec2f, pixel: vec2u) -> vec3f {
  let prism = scenePrism(scene);
  let lamp = sceneLamp(scene);
  var radiance = vec3f(0.0);
  for (var index = 0u; index < scene.raysPerFragment; index = index + 1u) {
    let ray = sceneRay(scene, pixel, index);
    let weight = traceRayWeight(prism, lamp, point, ray.aim, ray.ior, scene.maxBounces);
    if (weight <= 0.0) {
      continue;
    }
    radiance = radiance + wavelengthToLinearRgb(ray.wavelength) * weight;
  }
  return radiance * (scene.exposure / f32(scene.raysPerFragment));
}
