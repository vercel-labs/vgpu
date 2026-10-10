---
"vgpu": minor
---

## Summary

Reject canvas `Surface` objects passed to Draw, Effect, or Compute input bindings. Constructor `set` options and later `set()` calls now throw `VGPU-SURFACE-NOT-BINDABLE` before acquiring the current presentation texture; surfaces remain supported as render destinations.

## Migration

### Affected usage

Code that passed a `Surface` itself as a shader resource must change, including per-frame calls such as `consumer.set({ source: screen })` that previously acquired that frame's presentation texture.

### Steps

Render sampled intermediate work to an offscreen `Target`, bind that target to follow its attachment replacements, and use the `Surface` only for the presentation pass. Bind an explicit `Texture` instead when retaining that exact texture identity is intentional; unlike a bound target, it does not follow attachment replacement after resize.

#### Before

```ts illustrative
frame(gpu, (currentFrame) => {
  currentFrame.pass(screen, producer);
  consumer.set({ source: screen });
  currentFrame.pass(preview, consumer);
});
```

#### After

```ts
import { effect, frame, init, surface, target } from "vgpu";

const gpu = await init();
const screen = surface(gpu, document.querySelector("canvas")!);
const intermediate = target(gpu, { size: screen.size });
const producer = effect(gpu, `
  @fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, 0.0, 1.0);
  }
`);
const consumer = effect(gpu, `
  @group(0) @binding(0) var source: texture_2d<f32>;
  @fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureLoad(source, vec2i(uv * vec2f(textureDimensions(source))), 0);
  }
`, { set: { source: intermediate } });

screen.onResize(({ width, height }) => intermediate.resize([width, height]));
frame(gpu, (currentFrame) => {
  currentFrame.pass(intermediate, producer);
  currentFrame.pass(screen, consumer);
});
```

### Verification

Confirm that no Draw, Effect, or Compute input binding receives a `Surface`, and render through `frame()` / `frameLoop()` with the surface as a pass target. For intermediate readback, use `await intermediate.color.read({ mipLevel: 0, region: "all" })`; current presentation readback remains `surface.color.read(...)` and does not gain a delayed-frame guarantee.
