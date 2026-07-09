# Device

`Device` is the opaque core module around a raw `GPUDevice`. It creates buffers,
owns the queue wrapper, captures structured validation errors through error scopes,
and exposes the raw WebGPU object via `.gpu` for mechanical escape-hatch use.
Use `destroy()` or `dispose()` for teardown.

## Capabilities

`device.limits` and `device.features` are transparent accessors for the underlying
WebGPU device capabilities. They do not negotiate, normalize, or polyfill support;
use them to inspect limits and gate optional paths without reaching through `.gpu`.

`device.isCompatibilityMode` is `true` when the adapter requested WebGPU
`featureLevel: "compatibility"`; otherwise it defaults to `false`. Use it to
choose explicit compatibility-sensitive resource and shader variants together,
such as passing the same boolean to `cubeView(texture, { compat })` and your WGSL
binding selector. `cubeView` does not auto-detect compatibility mode because the
view dimension and shader binding type must stay in lockstep.

Native WebGPU:

```ts
const max = device.gpu.limits.maxTextureDimension2D;
const hasTimestamps = device.gpu.features.has("timestamp-query");
```

VGPU:

```ts
const max = device.limits.maxTextureDimension2D;
const hasTimestamps = device.features.has("timestamp-query");
```

Gate optional behavior with the same setlike feature checks that WebGPU exposes:

```ts
if (device.features.has("timestamp-query")) {
  // create timestamp query resources for this device
}
```
