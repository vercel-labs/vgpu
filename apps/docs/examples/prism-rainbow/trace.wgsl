// The estimator. Every fragment is a point in the room; it fires 16 rays at
// random points across the prism's face, refracts each one through the glass,
// and keeps whatever comes out the far side if it reaches the lamp.
//
// One frame of this is noisy by construction: a fragment only contributes when a
// randomly chosen point on the triangle happens to bend one of its 16
// wavelengths onto a lamp less than a degree wide. So the pass blends into the
// previous frame's estimate instead of replacing it, and the seed moves with
// `frameIndex` — the image converges rather than flickering.

import { Scene, estimateRadiance, scenePoint } from "./scene.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
/** Last frame's running average, or a cleared target on the first frame. */
@group(0) @binding(1) var history: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = vec2u(position.xy);
  let radiance = estimateRadiance(scene, scenePoint(scene, uv), pixel);
  let previous = textureLoad(history, vec2i(pixel), 0).rgb;
  // A running mean: blend = 1/n reproduces the average of every frame so far.
  // `scene.ts` sets it, and resets the count whenever the scene changes, which is
  // what keeps a moved lamp from being averaged against a stale image.
  return vec4f(mix(previous, radiance, scene.blend), 1.0);
}
