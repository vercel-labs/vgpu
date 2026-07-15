# `gpu.compute` and `Compute`

`gpu.compute()` is first-class and uses the same WGSL reflection and `set()` ownership rules as pass/draw. `dispatch(x, y?, z?)` encodes a compute pass and submits it.

```ts
const sim = gpu.compute(/* wgsl */ `
  struct Sim { dt: f32 }
  @group(0) @binding(0) var<uniform> sim: Sim;
  @group(0) @binding(1) var<storage, read> src: array<vec4f>;
  @group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;

  @compute @workgroup_size(64)
  fn cs_main(@builtin(global_invocation_id) id: vec3u) {
    dst[id.x] = src[id.x] + vec4f(0, -9.8 * sim.dt, 0, 0);
  }
`);
const particles = gpu.pingPongStorage(COUNT * 16);

gpu.frame.loop(() => {
  sim.set({ dt: gpu.deltaTime, src: particles.read, dst: particles.write });
  sim.dispatch(Math.ceil(COUNT / 64));
  particles.swap();
});
```

Dev mode pre-checks writable storage aliasing before dispatch. Binding the same buffer as both `src` and writable `dst` throws with a fix-it to use `gpu.pingPongStorage()`.

## Ownership and performance defaults

- WGSL is the source of truth. Declare every `@group/@binding` in the shader and bind by name with `set()`.
- JS values passed to `set()` are lib-owned and are written in-place (R1/R2), so animated uniforms do not recreate bind groups.
- Resources (`Uniform`, storage buffers, textures, targets, samplers, claimed bind groups) are user-owned; vgpu only binds their identity.
- Time is explicit JS (`gpu.time`, `gpu.deltaTime`, `gpu.frameCount`). Resolution lives on targets (`target.size`, `target.texelSize`).
