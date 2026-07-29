---
"@vgpu/core": minor
"vgpu": minor
---

Support float texture formats in texture/target readback, closing the gap where `target.read()` on an HDR target threw `VGPU-CORE-UNSUPPORTED-FORMAT`.

`Texture.read()`, `Target.read()`, and `Surface.read()` now copy back `rgba16float`, `rgba32float`, `r16float`, `rg16float`, `r32float`, `rg32float`, `r8unorm`, and `rg8unorm` in addition to the existing `rgba8unorm` / `rgba8unorm-srgb` / `bgra8unorm` / `bgra8unorm-srgb`. `read()` keeps its `Promise<Uint8Array>` signature and returns the raw unpadded texel bytes of the texture's own format (`width * height * bytesPerPixel`), so `rgba8unorm` readback is byte-for-byte unchanged.

New `Texture.readFloats()` / `Target.readFloats()` / `Surface.readFloats()` return a `Float32Array` with one f32 per component (row-major, `width * height * components` long): binary16 texels are widened to f32 (subnormals, infinities, and NaN included), f32 texels are copied verbatim, and `unorm8` texels are normalized to `[0, 1]` without srgb gamma conversion — so HDR values above `1` and negatives survive the readback instead of being clamped into bytes.

Formats outside that table (depth/stencil, packed such as `rgb10a2unorm` / `rg11b10ufloat`, snorm/uint/sint, and compressed) still throw `VGPU-CORE-UNSUPPORTED-FORMAT`, now listing the supported formats in the message.

The mock device also gained a real `queue.writeTexture` and allocates its texel storage from the texture's format and layer count, so `writeTexture` + `read()` / `readFloats()` round-trips per format on the mock adapter with the same byte layout a real device produces: `bytesPerRow` / `rowsPerImage` padding, `origin` (including array layers) and the `bgra*` → RGBA swizzle all behave as they do on a real readback, `read()` returns layer 0 like `copyTextureToBuffer` does, and unsupported formats are rejected on the mock exactly as they are on a real device. The mock stores mip 0 only, so `writeTexture` with `mipLevel > 0` now throws instead of silently corrupting mip 0.

Note for custom `Target` implementers (pre-1.0): the `Target` interface gained a required `readFloats(): Promise<Float32Array>` member. Delegating to `this.color.readFloats()` — what `target(gpu)` and `surface(gpu)` do — is enough.
