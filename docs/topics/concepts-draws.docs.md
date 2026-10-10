---
title: Draws
summary: draw(gpu, opts) renders geometry with custom vertex buffers — you write the vertex stage, geometry(gpu, ...) supplies the buffers.
relatedSymbols:
  - Draw
  - DrawOptions
  - GeometryLike
prevNext:
  prev:
    title: WGSL modules
    href: /concepts/wgsl-modules
  next:
    title: Compilation
    href: /concepts/compilation
order: 20
---

# Draws

A [`Draw`](/reference/vgpu/draw#draw) renders geometry with custom vertex buffers: you write both the vertex and the fragment stage, and a geometry supplies the buffers. If you want to render a full-screen shader instead, use an [Effect](/concepts/effects).

## Draw a geometry

`geometry(gpu, geometry)` turns geometry from `vgpu/scene` into vertex and index buffers. Your vertex shader declares the attributes it consumes — `@location(0) position`, `@location(1) normal` — and the geometry feeds them.

```wgsl
// cube.wgsl
struct Camera { viewProjection: mat4x4f }
struct Model { model: mat4x4f }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;

struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f }

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = camera.viewProjection * model.model * vec4f(position, 1.0);
  out.normal = normal;
  return out;
}

@fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
  let light = max(dot(normalize(normal), normalize(vec3f(1.0, 1.0, 1.0))), 0.15);
  return vec4f(vec3f(0.2, 0.5, 1.0) * light, 1.0);
}
```

```ts
import { init, draw, geometry, target } from "vgpu";

const gpu = await init();

// ---cut---
import { box, composeMatrix, orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";
import cubeShader from "./cube.wgsl";

const colorTarget = target(gpu, { size: [1280, 720], depth: true });
const rig = orbitRig({ yaw: 0.59, pitch: 0.51, distance: 4.12 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, 16 / 9, new Float32Array(16));
const camera = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, pose), projection, camera);
const model = composeMatrix({}, new Float32Array(16));

const cube = draw(gpu, { shader: cubeShader, geometry: geometry(gpu, box({ size: 1 })) });
cube.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model },
});

cube.draw(colorTarget);
```

Everything works like the rest of vgpu: bindings come from the reflection the `@vgpu/wgsl` loader prepared for `cube.wgsl` at build time, `set()` writes uniforms by name, and the draw renders one-shot into any target. Pipelines are compiled per target format and cached, so the same `Draw` can render into different targets. See [Compilation](/concepts/compilation) to pre-warm each signature before the first draw.

The shader chooses the camera's group and binding. `cube.set({ camera: { viewProjection } })` connects the matrix by the WGSL variable name; scene utilities do not reserve a group or inject uniforms. `set()` copies the values at the time of the call, so call it again after changing a matrix. See [Scene composition](/guides/scene-composition) for hierarchies, external camera state, and instances. For shared instance streams, declare the complete attribute layout in each consuming vertex entry, including inputs unused by a particular pass.

Three details specific to geometry:

- For depth-tested 3D presented directly to the canvas, use `surface(gpu, canvas, { depth: true, msaa: true })`. Use an offscreen `target(gpu, { depth: true })` when another pass needs to sample the scene image; [Two-pass rendering](/guides/two-pass-rendering) shows both paths. Deep scenes fight z-fighting with reversed-Z: `depth: { compare: "greater" }` on the draw, `clearDepth: 0` on the pass.
- A closed geometry like this box never shows its back faces — add `cull: "back"` to the draw and skip roughly half the fragment work.
- `GeometryLike` is an open interface: `geometry(gpu)` builds one from `vgpu/scene` geometry, but you can also pass your own `GPUBuffer`s and vertex layouts. See the [reference](/reference/vgpu/draw#geometrylike).

## No geometry? You spawn triangles

Leave `geometry` out and the draw runs with no buffers at all: `vertices` defaults to `3`, so every instance is one triangle whose corners you position from `@builtin(vertex_index)`. Combined with `instances`, that spawns a particle system from nothing:

```wgsl
// smoke.wgsl
struct Params { time: f32 }
@group(0) @binding(0) var<uniform> params: Params;

struct Out { @builtin(position) position: vec4f, @location(0) fade: f32 }

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.5));
  let seed = fract(sin(f32(i) * 12.9898) * 43758.5453);
  let life = fract(seed + params.time * 0.05);          // 0 -> 1, then respawn
  let center = vec2f(seed * 2.0 - 1.0, life * 2.2 - 1.1); // drifts upward
  let size = 0.01 + life * 0.04;                          // grows as it rises

  var out: Out;
  out.position = vec4f(center + corners[v] * size, 0.0, 1.0);
  out.fade = 1.0 - life;
  return out;
}

@fragment fn fs_main(@location(0) fade: f32) -> @location(0) vec4f {
  return vec4f(vec3f(0.35) * fade, 1.0); // dims into the dark background
}
```

```ts
import { init, draw, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);

// ---cut---
import smokeShader from "./smoke.wgsl";

const smoke = draw(gpu, { shader: smokeShader, instances: 10_000 });

smoke.set({ params: { time: 2.5 } }); // drive with clock(gpu).time in a frame loop
smoke.draw(canvasSurface);
```

One draw call, 10,000 smoke puffs, zero buffers — each particle derives its position, size, and fade from `instance_index` and `time`. Counts can also change per call: `smoke.draw({ target: surface, instances: 500 })`.

See it live: the [instanced rendering example](/examples/instanced-rendering) drives a 125k-cube lattice from a single instance stream.
