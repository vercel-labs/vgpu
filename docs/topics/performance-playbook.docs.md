# Performance playbook: write fast vgpu by default

This guide is for LLMs and humans writing shaders. Treat these as default shapes, not late-stage optimizations: each **After** snippet is the pattern to copy when the situation matches.

## 1. Bundles / replay (`gpu.bundle` + `p.bundles`)

Use when static draws repeat every frame. Bundles freeze commands, bind groups, target formats, sample count, and attachment identity; they do **not** freeze buffer contents.

Before:
```text
gpu.frame.loop((f) => f.pass({ target: scene }, (p) => {
  p.draw(floor);
  p.draw(walls);
  p.draw(player);
}));
```
After:
```text
const staticScene = gpu.bundle({ target: scene }, (b) => {
  b.draw(floor);
  b.draw(walls);
});
gpu.frame.loop((f) => f.pass({ target: scene }, (p) => {
  p.bundles(staticScene);
  p.draw(player);
}));
```
Default: bundle static work once and replay with `p.bundles(...)`.

## 2. Pipeline pre-warm (`compile`)

Use before the first visible frame or route transition. This compiles render pipelines for the target color/depth/MSAA signature before the hitch-sensitive frame.

Before:
```text
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()) });
```
After:
```text
const scene = gpu.target({ size: [256, 256], format: "rgba16float", depth: true, msaa: true });
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()) });
await cube.compile(scene);
gpu.frame((f) => f.pass({ target: scene }, (p) => p.draw(cube)));
```
Default: `await draw.compile(target)` for every target signature a draw will hit before the hitch-sensitive frame. `targets: [target]` remains synchronous creation-time sugar when blocking is acceptable.

## 3. Manual group claim + dynamic offsets (`draw.group`)

Use for hundreds or thousands of objects that share one shader and one bind-group layout. `draw.group()` claims a reflected group; offsets travel per draw call.

Before:
```text
for (const obj of objects) {
  cube.set({ model: obj.model });
  p.draw(cube);
}
```
After:
```text
import { UniformPool, type UniformLayout } from "vgpu/core";

type ObjectUniforms = { model: Float32Array };
const objectLayout: UniformLayout<ObjectUniforms> = {
  size: 64,
  bindGroupLayout: cube.layout(1, { dynamicOffsets: true }),
  encode(value, dst, byteOffset) {
    new Float32Array(dst, byteOffset, 16).set(value.model);
  },
};
const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
const slot = pool.alloc(objectLayout);
cube.group(1, slot.bindGroup);

gpu.frame.loop((f) => {
  pool.beginFrame(gpu.frameCount);
  f.pass({ target: scene }, (p) => {
    for (const obj of objects) {
      const offset = slot.push({ model: obj.model });
      p.draw(cube, { offsets: { 1: [offset] } });
    }
  });
  pool.endFrame();
});
```
Default: for many per-object uniforms, allocate a `UniformPool` slot with an `encode(...)` function, call `pool.beginFrame(...)`, push values, draw with offsets, then `pool.endFrame()` before the frame submits.

## 4. `set()` in-place

Use for animated JS values. The first `set()` latches ownership: plain JS values are lib-owned and update in place; resources are user-owned and keep their identity.

Before:
```text
const wave = gpu.effect(WAVE_WGSL, { set: { time: 0, speed: 2 } });
gpu.frame.loop((frame) => {
  wave.set({ time: gpu.time, speed: 2 });
  frame.pass(target, wave);
});
```
After:
```text
const wave = gpu.effect(WAVE_WGSL, { set: { time: 0, speed: 2 } });
gpu.frame.loop((frame) => {
  wave.set({ time: gpu.time });
  frame.pass(target, wave);
});
```
Default: create once; update changing numbers/vectors/structs with `set()`. `set()` performs no equality check — a value written every frame is uploaded
every frame, so hoist static and resize-class values out of the render loop.

## 5. Bake static inputs once

Use when a heavy pass produces a texture that does not change every frame.

Before:
```text
gpu.frame.loop((f) => {
  f.pass({ target: baked }, (p) => p.draw(heavyScene));
  post.set({ src: baked.color, texel: baked.texelSize });
  f.pass({ target: screen }, (p) => p.draw(post));
});
```
After:
```text
gpu.frame((f) => f.pass({ target: baked }, (p) => p.draw(heavyScene)));
post.set({ src: baked.color, texel: baked.texelSize });
gpu.frame.loop((f) => f.pass({ target: screen }, (p) => p.draw(post)));
```
Default: if an input is static, bake it outside the loop with one `gpu.frame(...)`.

## 6. Instancing (`instances`, `vertices`)

Use for N copies of the same geometry. `DrawOptions.instances/vertices/firstInstance` set defaults; `DrawCallOptions.instances/vertices/firstVertex/firstInstance` override per call. `instances: 0` is valid; indexed meshes ignore `vertices` and `firstVertex`.

Before:
```text
for (let i = 0; i < COUNT; i++) {
  particles.set({ particleIndex: i });
  p.draw(particles);
}
```
After:
```text
const particles = gpu.draw({ shader: PARTICLE_WGSL, instances: COUNT, vertices: 6 });
await particles.compile(scene);
particles.set({ particleBuffer });
gpu.frame.loop((f) => f.pass({ target: scene }, (p) => p.draw(particles)));
```
Default: one draw with `instances` beats N draw calls.

## 7. `gpu.uniforms()` shared values

Use when many shaders consume the same time, camera, mouse, or exposure values.

Before:
```text
wave.set({ time: gpu.time, mouse });
blur.set({ time: gpu.time, mouse });
post.set({ time: gpu.time, mouse });
```
After:
```text
const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
const wave = gpu.effect(WAVE_WGSL, { set: { globals } });
const blur = gpu.effect(BLUR_WGSL, { set: { globals } });
gpu.frame.loop((frame) => {
  globals.set({ time: gpu.time, mouse });
  frame.pass(target, (pass) => {
    pass.draw(wave);
    pass.draw(blur);
  });
});
```
Default: shared values belong in one `gpu.uniforms()` object.

## 8. Ping-pong (`pingPong`) without churn + two bundles

Use for iterative effects. Ping-pong keeps two stable identities, so bind-group caches can reuse them.

Before:
```text
gpu.frame.loop((f) => {
  const tmp = gpu.target({ size: [256, 256], format: "rgba16float" });
  sim.set({ src: previous.color });
  f.pass({ target: tmp }, (p) => p.draw(sim));
  previous = tmp;
});
```
After:
```text
const state = gpu.pingPong(512, 512, { format: "rgba16float" });
const even = gpu.bundle({ target: state.write }, (b) => { sim.set({ src: state.read.color }); b.draw(sim); });
state.swap();
const odd = gpu.bundle({ target: state.write }, (b) => { sim.set({ src: state.read.color }); b.draw(sim); });
state.swap();
let parity = 0;
gpu.frame.loop((f) => {
  f.pass({ target: state.write }, (p) => p.bundles(parity === 0 ? even : odd));
  state.swap();
  parity ^= 1;
});
```
Default: create ping-pong resources once; if you bundle, record both parity cases and replay the matching one.

## 9. MSAA/depth in the target

Use for 3D anti-aliasing and depth testing. Resolution, depth, color format, and sample count are target state.

Before:
```text
const scene = gpu.target({ size: [256, 256], format: "rgba8unorm" });
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()) });
```
After:
```text
const scene = gpu.target({ size: [256, 256], format: "rgba16float", depth: true, msaa: true });
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()) });
await cube.compile(scene);
gpu.frame.loop((f) => f.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(cube)));
```
Default: put depth/MSAA on the target; do not invent global render settings.
