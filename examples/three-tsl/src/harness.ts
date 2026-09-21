// Offscreen verification harness: renders the lava material into a
// RenderTarget with a stubbed canvas context, so it runs in headless
// chromium where WebGPU canvas presentation is unavailable.
//
// Query params: ?mesh=sphere|knot|plane  &t=<seconds, fixed frame time>
//               &size=<pixels>  &dist=<camera distance>
//               &glow=<emissive intensity>  &light=<key light multiplier>
//               &post=0 (linear readback, no output transform)
import * as THREE from "three/webgpu";
import { float } from "three/tsl";
import { createDemoCamera, createDemoScene, type DemoMeshKind } from "./scenes.ts";
import { createOutputPipeline } from "./post.ts";

declare global {
  interface Window { __result?: unknown }
}

async function run(): Promise<unknown> {
  const params = new URLSearchParams(location.search);
  const meshKind = (params.get("mesh") ?? "sphere") as DemoMeshKind;
  const frameTime = Number(params.get("t") ?? "0");
  const size = Number(params.get("size") ?? "256");
  const glowOverride = params.get("glow");

  const fakeContext = {
    configure() {},
    unconfigure() {},
    getCurrentTexture(): never { throw new Error("harness renders offscreen only"); },
  };
  const renderer = new THREE.WebGPURenderer({ context: fakeContext as unknown as GPUCanvasContext });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await renderer.init();

  const { scene } = await createDemoScene({
    renderer,
    mesh: meshKind,
    timeNode: float(frameTime),
    lightScale: Number(params.get("light") ?? "1"),
    glowIntensity: glowOverride === null ? undefined : Number(glowOverride),
  });

  const dist = Number(params.get("dist") ?? "4.2");
  const camera = createDemoCamera(1);
  camera.position.set(0, (1.2 * dist) / 4.2, dist);
  camera.lookAt(0, 0, 0);

  // With the output chain, MSAA lives on the scene pass; the final output
  // transform needs no samples of its own.
  const withPost = params.get("post") !== "0";
  const target = new THREE.RenderTarget(size, size, { samples: withPost ? 1 : 4 });
  renderer.setRenderTarget(target);
  if (withPost) {
    const postProcessing = createOutputPipeline(renderer, scene, camera);
    await postProcessing.renderAsync();
  } else {
    await renderer.renderAsync(scene, camera);
  }
  const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size)) as Uint8Array;

  let lit = 0;
  const distinct = new Set<string>();
  // Average color of dim (crust) pixels in the center band, for tuning.
  let crustSum = [0, 0, 0];
  let crustCount = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    const delta = Math.abs(pixels[i]! - 11) + Math.abs(pixels[i + 1]! - 13) + Math.abs(pixels[i + 2]! - 16);
    if (delta > 60) lit++;
    const y = Math.floor(i / 4 / size);
    if (delta <= 60 && delta > 8 && y > size * 0.3 && y < size * 0.8) {
      crustSum = [crustSum[0]! + pixels[i]!, crustSum[1]! + pixels[i + 1]!, crustSum[2]! + pixels[i + 2]!];
      crustCount++;
    }
  }
  const crust = crustCount ? crustSum.map((v) => Math.round(v / crustCount)) : null;

  // Blit the readback into a plain 2D canvas so the result is visible (and
  // screenshotable) even where WebGPU canvas presentation is unavailable.
  const view = document.createElement("canvas");
  view.width = size;
  view.height = size;
  view.style.width = `${Math.max(size, 512)}px`;
  view.style.imageRendering = "pixelated";
  const context2d = view.getContext("2d")!;
  const image = context2d.createImageData(size, size);
  // WebGPU framebuffers are top-left origin: rows come back top-down already.
  image.data.set(pixels.subarray(0, size * size * 4));
  context2d.putImageData(image, 0, 0);
  document.body.append(view);

  return { mesh: meshKind, total: pixels.length / 4, lit, distinct: distinct.size, crust };
}

run().then(
  (result) => { window.__result = result; },
  (error) => { window.__result = { error: String(error && (error as Error).message) }; },
);
