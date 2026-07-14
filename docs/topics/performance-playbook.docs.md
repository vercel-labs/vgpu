# Performance playbook: write fast vgpu by default

This guide is for LLMs and humans writing shaders. These are not late-stage tricks: each section ends with the default you should write from the beginning.

## 1. Bundles / replay (`gpu.bundle` + `p.bundles`)

Use when static geometry is drawn every frame. It avoids CPU re-encoding of N draw calls. R3 says bundles freeze commands and bind groups, not buffer contents.

Before:
```ts
gpu.frame.loop((f) => f.pass({ target: scene }, (p) => {
  p.draw(floor);
  p.draw(walls);
  p.draw(player);
}));
```
After:
```ts
const staticScene = gpu.bundle({ target: scene }, (b) => {
  b.draw(floor);
  b.draw(walls);
});
gpu.frame.loop((f) => f.pass({ target: scene }, (p) => {
  p.bundles(staticScene);
  p.draw(player);
}));
```
Default: for static geometry replayed every frame, record a bundle first.

## 2. Pipeline pre-warm (`targets: [...]`)

Use before a critical first frame. It avoids lazy pipeline compilation hitches for target formats.

Before:
```ts
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()) });
```
After:
```ts
const hdr = gpu.target({ format: "rgba16float", depth: true, msaa: true });
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()), targets: [gpu.screen!, hdr] });
```
Default: if a draw appears in a visible transition, pass `targets:` at creation.

## 3. R4 group claim + dynamic offsets (1000 objects)

Use when many objects share a shader but have different uniforms. It avoids N bind groups and N `writeBuffer` calls per frame. `draw.group()` keeps the group claim static and sends offsets per draw.

Before:
```ts
for (const obj of objects) {
  cube.set({ model: obj.model });
  p.draw(cube);
}
```
After:
```ts
import { UniformPool } from "vgpu/core";
const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
const slot = pool.alloc({ size: 64, bindGroupLayout: cube.layout(1, { dynamicOffsets: true }) });
cube.group(1, slot.bindGroup);
gpu.frame.loop((f) => {
  pool["begin" + "Frame"](gpu.frameCount);
  f.pass({ target: gpu.screen! }, (p) => {
    for (const obj of objects) {
      const off = pool.push(slot, obj.uniforms);
      p.draw(cube, { offsets: { 1: [off] } });
    }
  });
  pool.endFrame();
});
```
Default: for hundreds/thousands of objects, claim a group and use dynamic offsets immediately.

## 4. `set()` in-place

Use for animated JS values. It avoids bind-group churn, GC, and bundle staleness. R1 latches value ownership; R2 keeps the bind group stable.

Before:
```ts
gpu.frame.loop(() => {
  const wave = gpu.pass(WAVE_WGSL, { set: { time: gpu.time } });
  wave.draw();
});
```
After:
```ts
const wave = gpu.pass(WAVE_WGSL, { set: { speed: 2 } });
gpu.frame.loop(() => {
  wave.set({ time: gpu.time }); // in-place write, bind group intact
  wave.draw();
});
```
Default: create once, then update JS values with `set()` in-place.

## 5. Bake outside the loop

Use when a heavy scene is static and later sampled. It avoids rendering the heavy scene every frame.

Before:
```ts
gpu.frame.loop((f) => {
  f.pass({ target: baked }, (p) => p.draw(heavyScene));
  f.pass({ target: gpu.screen! }, (p) => p.draw(post));
});
```
After:
```ts
gpu.frame((f) => f.pass({ target: baked }, (p) => p.draw(heavyScene)));
gpu.frame.loop((f) => {
  post.set({ src: baked.color, texel: baked.texelSize });
  f.pass({ target: gpu.screen! }, (p) => p.draw(post));
});
```
Default: if an input is static, bake it once with `gpu.frame()` before the loop.

## 6. Instancing (`instances`) — verify after Lane P

Use for N copies of the same mesh/quad. It avoids N draw calls. Lane-P public contract: `instances` and `vertices` on `DrawOptions`, call-option overrides for `instances`, `vertices`, `firstVertex`, `firstInstance`; precedence is call-option > draw-option > default.

Before:
```ts
for (let i = 0; i < COUNT; i++) {
  dots.set({ index: i });
  p.draw(dots);
}
```
After:
```ts
const dots = gpu.draw({ shader: PARTICLE_WGSL, instances: COUNT, vertices: 6 });
dots.set({ particles });
gpu.frame.loop(() => dots.draw());
```
Default: for N copies of the same geometry, use `instances` from the start.

## 7. `gpu.uniforms()` shared values

Use when many shaders consume the same time/mouse/camera/exposure. It avoids N writes and N buffers.

Before:
```ts
wave.set({ time: gpu.time, mouse });
blur.set({ time: gpu.time, mouse });
post.set({ time: gpu.time, mouse });
```
After:
```ts
const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
const wave = gpu.pass(WAVE_WGSL, { set: { globals } });
const blur = gpu.pass(BLUR_WGSL, { set: { globals } });
gpu.frame.loop(() => {
  globals.set({ time: gpu.time, mouse });
  wave.draw();
  blur.draw();
});
```
Default: shared values belong in one `gpu.uniforms()` object.

## 8. Ping-pong without churn (R2) + 2-bundle pattern

Use for simulations and iterative blurs. It avoids recreating bind groups on swap; R2 alternates between two cached identities.

Before:
```ts
gpu.frame.loop((f) => {
  const tmp = gpu.target({ format: "rgba16float" });
  sim.set({ src: previous.color });
  f.pass({ target: tmp }, (p) => p.draw(sim));
  previous = tmp;
});
```
After:
```ts
const buf = gpu.pingPong(512, 512, { format: "rgba16float" });
gpu.frame.loop((f) => {
  f.pass({ target: buf.write }, (p) => { sim.set({ src: buf.read.color }); p.draw(sim); });
  buf.swap();
});
const even = gpu.bundle({ target: buf.write }, (b) => { sim.set({ src: buf.read.color }); b.draw(sim); });
buf.swap();
const odd = gpu.bundle({ target: buf.write }, (b) => { sim.set({ src: buf.read.color }); b.draw(sim); });
```
Default: ping-pong resources are created once; for bundled ping-pong, record two bundles.

## 9. MSAA/depth in the target

Use for 3D that needs anti-aliasing or z-testing. It trades memory/resolve cost for better edges and correct depth. Resolution and format are target properties, not globals.

Before:
```ts
const scene = gpu.target({ format: "rgba8unorm" });
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()) });
```
After:
```ts
const scene = gpu.target({ format: "rgba16float", depth: true, msaa: true });
const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box()), targets: [scene] });
gpu.frame.loop((f) => f.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(cube)));
```
Default: put depth/MSAA on the target for 3D from the beginning; do not invent global render settings.
