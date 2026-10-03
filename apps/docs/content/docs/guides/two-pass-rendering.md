---
title: "Two-pass rendering: offscreen depth target composited to the canvas"
description: "Render a 3D scene into an offscreen `target(gpu, { depth: true })` and composite it onto the canvas when a later pass must sample the image; plain depth-tested 3D renders in one pass to `surface(gpu, canvas, { depth: true, msaa: true })`."
---

Two-pass rendering draws the scene into an offscreen target, then draws that target's color onto the canvas with one full-screen effect. Use it when a later pass must sample the rendered scene: post-processing, feedback or history, or reading the image back after it presents.

3D alone does not require two passes. A surface created with `depth` owns a depth attachment, so [Draws](concepts-draws.docs.md) depth-test straight into the canvas:

1. **Only presenting the scene?** Render it to `surface(gpu, canvas, { depth: true, msaa: true })` in one pass.
2. **Sampling the scene afterwards?** Render it to an offscreen `target(gpu, { size, depth: true })`, then present that target's color in a second pass.

[Draws](concepts-draws.docs.md), [Passes](concepts-passes.docs.md), and [Frames](concepts-frames.docs.md) each describe one part of this. This guide is the copy-pasteable whole for both paths.

## Render 3D directly to the canvas

```ts
import { draw, frameLoop, geometry, init, surface } from "vgpu";
import { box, composeMatrix, orbitRig, perspective, rigPose, sphere, viewMatrices } from "vgpu/scene";
import objectShader from "./object.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;

// Both objects share shading; vertex entrypoints match their different attribute layouts.
// ---cut---
// One target: the canvas, with an owned depth24plus attachment and 4× MSAA.
const canvasSurface = surface(gpu, canvas, { depth: true, msaa: true });

const rig = orbitRig({ yaw: 0.62, pitch: 0.44, distance: 4.74 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = new Float32Array(16);
const camera = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
const cubeWorld = composeMatrix({ position: [1, 0, 0] }, new Float32Array(16));
const ballWorld = composeMatrix({
  position: [Math.cos(2.1), 0, Math.sin(2.1)], rotation: [0, 2.1, 0],
}, new Float32Array(16));

const cube = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_box" },
  geometry: geometry(gpu, box({ size: 1 })), cull: "back",
});
const ball = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_sphere" },
  geometry: geometry(gpu, sphere({ radius: 0.6 })), cull: "back",
});

canvasSurface.onResize(({ width, height }) => { // fires now, then after every resize
  perspective({ fov: 45, near: 0.1, far: 100 }, width / height, projection);
  viewMatrices(rigPose(rig, pose), projection, camera);
  cube.set({
    camera: { viewProjection: camera.viewProjection },
    model: { model: cubeWorld, color: [0.95, 0.45, 0.2] },
  });
  ball.set({
    camera: { viewProjection: camera.viewProjection },
    model: { model: ballWorld, color: [0.3, 0.6, 1] },
  });
});

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface, clear: [0.04, 0.05, 0.08, 1] }, (pass) => {
    pass.draw(cube);
    pass.draw(ball); // depth-tested against the cube, whatever the order
  });
});
```

The pass clears depth to `1` by default, the draws keep their default depth state (`write: true`, `compare: "less-equal"`), and the 4-sample color resolves into the canvas texture at the end of the pass. The shader, geometry, camera, and uniforms are all application-owned; the surface owns only its attachments and replaces them on resize.

The surface's depth and MSAA come with pass rules: with `msaa`, every surface pass must clear, because multisample attachments are discarded after each pass (`clear: false` throws `VGPU-PASS-PRESERVE-MSAA`). Encode a frame's draws into one surface pass. See [`Surface`](/reference/vgpu/surface#surface) for attachment lifetimes, resize, and reading a single-sample `surface.depth`.

```wgsl
// object.wgsl
struct Camera { viewProjection: mat4x4f }
struct Model { model: mat4x4f, color: vec3f }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;

struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f }

fn vertex(position: vec3f, normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = camera.viewProjection * model.model * vec4f(position, 1.0);
  out.normal = (model.model * vec4f(normal, 0.0)).xyz;
  return out;
}

@vertex fn vs_box(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  return vertex(position, normal);
}

@vertex fn vs_sphere(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOut {
  return vertex(position, normal);
}

@fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
  let light = max(dot(normalize(normal), normalize(vec3f(1.0, 1.0, 1.0))), 0.15);
  return vec4f(model.color * light, 1.0);
}
```

```wgsl
// present.wgsl
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(scene, sceneSampler, uv, 0.0);
}
```

## The recipe

Use two passes whenever a later pass reads the rendered scene as a texture — a post-processing chain, temporal history, or `color.read(...)` after presentation. A surface cannot be an input binding (`VGPU-SURFACE-NOT-BINDABLE`), and its color is the current canvas texture, replaced after each presentation.

```ts
import { draw, effect, frame, geometry, init, sampler, surface, target } from "vgpu";
import { box, composeMatrix, orbitRig, perspective, rigPose, sphere, viewMatrices } from "vgpu/scene";
import objectShader from "./object.wgsl";
import presentShader from "./present.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;

// Both objects share shading; vertex entrypoints match their different attribute layouts.
// Pass 2 reads pass 1's color texture and writes it to the canvas.
// ---cut---
const width = 960;
const height = 540;

// Pass 1 target: offscreen, with depth, and sampleable by later passes — a surface is not.
const scene = target(gpu, { size: [width, height], depth: true });
// Pass 2 target: the canvas the user actually sees.
const canvasSurface = surface(gpu, canvas);

const rig = orbitRig({ yaw: 0.62, pitch: 0.44, distance: 4.74 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, width / height, new Float32Array(16));
const camera = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, pose), projection, camera);
const cubeWorld = composeMatrix({ position: [1, 0, 0] }, new Float32Array(16));
const ballWorld = composeMatrix({
  position: [Math.cos(2.1), 0, Math.sin(2.1)], rotation: [0, 2.1, 0],
}, new Float32Array(16));

const cube = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_box" },
  geometry: geometry(gpu, box({ size: 1 })), cull: "back",
});
cube.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model: cubeWorld, color: [0.95, 0.45, 0.2] },
});

const ball = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_sphere" },
  geometry: geometry(gpu, sphere({ radius: 0.6 })), cull: "back",
});
ball.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model: ballWorld, color: [0.3, 0.6, 1] },
});

// The present pass is a single full-screen effect bound to the offscreen target.
const present = effect(gpu, presentShader, {
  set: { scene, sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: scene, clear: [0.04, 0.05, 0.08, 1], clearDepth: 1 }, (pass) => {
    pass.draw(cube);
    pass.draw(ball);
  });
  currentFrame.pass(canvasSurface, present);
});
```

Three things are doing the work:

- **`depth: true` on the offscreen target.** Without it the draws have no depth attachment and the two objects paint over each other in submission order. `clearDepth: 1` resets it every frame; use `clearDepth: 0` together with `depth: { compare: "greater" }` on the draw for reversed-Z in deep scenes.
- **Binding the target itself.** `set({ scene })` passes the `Target` where the WGSL declares a `texture_2d<f32>`; vgpu binds its color texture. Pair it with a `sampler(gpu, ...)` for the `sampler` binding.
- **One `frame()`.** Both passes are encoded into one command encoder and submitted once — see [Frames](concepts-frames.docs.md). Do not use one-shot `.draw()` calls inside a frame callback; they submit on their own and break the ordering.

Animating? Move the `frame(gpu, ...)` body into [`frameLoop(gpu, ...)`](concepts-frames.docs.md) and re-`set()` the model matrices from `clock(gpu).time` each tick. The targets, draws, and the present effect are all created once, outside the loop.

Camera and model matrices are ordinary application-owned arrays. Update them before the frame and call `set()` on each draw that needs the new values; mutation alone does not refresh a uniform. The shader owns both binding declarations. The normal calculation above assumes rotation and uniform scale; for nonuniform scale or shear, use `transformNormal` from `@vgpu/wgsl-std/scene` with the complete world matrix. [Scene composition](scene-composition.docs.md) covers that helper and external camera state.

The box supplies `position` and `normal`; the sphere also supplies `uv`. Their vertex entrypoints declare these complete layouts, even though this shader does not use UVs for shading.

## Headless / no-bundler variant

Rendering this from Node, a script, or a test instead of a browser? Everything is identical except that the second target is another offscreen target rather than a canvas surface, and you read the pixels back at the end:

```ts
import { draw, effect, frame, geometry, init, sampler, target } from "vgpu/node";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { box, composeMatrix, orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";

const objectShader = prepareShader("/* the same vertex + fragment shader as above */");
const presentShader = prepareShader("/* the same present shader as above */");
const width = 960;
const height = 540;

// ---cut---
const gpu = await init();
const scene = target(gpu, { size: [width, height], depth: true });
const output = target(gpu, { size: [width, height] });   // stands in for the canvas surface

const rig = orbitRig({ yaw: 0.62, pitch: 0.44, distance: 4.74 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, width / height, new Float32Array(16));
const camera = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, pose), projection, camera);
const cubeWorld = composeMatrix({ position: [1, 0, 0] }, new Float32Array(16));
const cube = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_box" },
  geometry: geometry(gpu, box({ size: 1 })), cull: "back",
});
cube.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model: cubeWorld, color: [0.95, 0.45, 0.2] },
});
const present = effect(gpu, presentShader, {
  set: { scene, sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: scene, clear: [0.04, 0.05, 0.08, 1], clearDepth: 1 }, (pass) => {
    pass.draw(cube);
  });
  currentFrame.pass(output, present);
});

const pixels = await output.color.read({ mipLevel: 0, region: "all" });   // RGBA bytes — assert on them, or encode a PNG
gpu.dispose();
```

To load the two shaders from `.wgsl` files instead of inline strings in this setup, resolve them first: [Using vgpu without a bundler](no-bundler.docs.md).

## Do you actually need two passes?

- **One full-screen fragment shader, no geometry?** No. Pass the effect to `currentFrame.pass(canvasSurface, effect)` inside `frame(gpu, ...)` or `frameLoop(gpu, ...)` — see [Getting started](getting-started.docs.md).
- **Flat 2D geometry with explicit paint order?** No. Open a single pass on the canvas and draw in order, as [Passes](concepts-passes.docs.md) shows.
- **3D geometry that occludes itself or another object, only presented?** No. Create the surface with `{ depth: true }` — add `msaa: true` for antialiased edges — and draw in one pass, as [Render 3D directly to the canvas](#render-3d-directly-to-the-canvas) shows.
- **Post-processing, history, or sampling the scene after it renders?** Yes, and the present pass is where it goes: replace `presentShader` with your post effect, which already samples the scene texture.
- **Reading the rendered image back later?** Yes. `surface.color.read(...)` reads only the current canvas texture; render into a `Target` and read `target.color` instead.

## See also

- [`Surface`](/reference/vgpu/surface#surface) — `depth` / `msaa` options, attachment lifetimes, and resize.
- [Draws](concepts-draws.docs.md) — why 3D geometry needs a depth attachment, plus `cull` and reversed-Z.
- [Passes](concepts-passes.docs.md) — the single-shader present-pass pattern used here.
- [Frames](concepts-frames.docs.md) — how `frame()` batches passes into one submit, and `frameLoop()` for animation.
- [Getting started](getting-started.docs.md) — the browser-first walkthrough this recipe extends.
- [Using vgpu without a bundler](no-bundler.docs.md) — loading the shaders above from `.wgsl` files.
