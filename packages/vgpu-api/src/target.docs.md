# `gpu.target`, `Target`, and `gpu.pingPong`

Targets own resolution, format, depth, MRT, and MSAA. There is no global resolution; pass `target.size` or `target.texelSize` explicitly when a shader needs it.

```ts
const scene = gpu.target({
  size: [1280, 720],
  format: "rgba16float",
  depth: true,
  msaa: true,
});

const post = gpu.pass(POST_WGSL);
gpu.frame.loop((f) => {
  f.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(cube));
  f.pass({ target: gpu.screen! }, (p) => {
    post.set({ src: scene.color, texel: scene.texelSize });
    p.draw(post);
  });
});
```

MRT is target-owned:

```ts
const gbuf = gpu.target({
  colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }],
  depth: true,
});
lighting.set({ gAlbedo: gbuf.colors[0], gNormal: gbuf.colors[1], gDepth: gbuf.depth, samp: gpu.sampler() });
```

Ping-pong alternates two target identities. R2 means the bind-group cache creates at most two bind groups for the alternating read/write pair, then reuses them.

```ts
const pingPong = gpu.pingPong(512, 512, { format: "rgba16float" });
gpu.frame.loop((f) => {
  f.pass({ target: pingPong.write }, (p) => {
    blur.set({ src: pingPong.read.color, texel: pingPong.read.texelSize });
    p.draw(blur);
  });
  pingPong.swap();
});
```

## Ownership and performance defaults

- WGSL is the source of truth. Declare every `@group/@binding` in the shader and bind by name with `set()`.
- JS values passed to `set()` are lib-owned and are written in-place (R1/R2), so animated uniforms do not recreate bind groups.
- Resources (`Uniform`, storage buffers, textures, targets, samplers, claimed bind groups) are user-owned; vgpu only binds their identity.
- Time is explicit JS (`gpu.time`, `gpu.deltaTime`, `gpu.frameCount`). Resolution lives on targets (`target.size`, `target.texelSize`).
