# Material

A `Material` is the GPU state needed to draw a mesh with a shader. It contains:

- `pipeline`: the ready-to-bind `GPURenderPipeline`.
- `bindGroupLayout`: the layout for per-draw uniforms at group 0.
- `shader`: the compiled vgpu shader object.
- `uniformByteSize`: the number of bytes each uniform record must provide.

## pbrMaterial

`pbrMaterial(spec)` creates a lit material for meshes that provide interleaved position and normal attributes. The default box mesh uses the matching vertex layout.

```ts
import { Mesh, pbrMaterial, srgb } from "@vgpu/render";

const mesh = Mesh.box({ device });
const material = pbrMaterial({
  device,
  baseColor: srgb(0xcc8844),
  metallic: 0,
  roughness: 0.5,
});
```

`baseColor` is linear RGB. If you are starting from an sRGB color value, pass it through `srgb(0xRRGGBB)` first.

`metallic` defaults to `0`. Higher values reduce diffuse light and tint specular light toward `baseColor`.

`roughness` defaults to `0.5`. Lower values make the simple specular highlight sharper; higher values make it broader.

The shader expects one uniform binding at group 0, binding 0. The record is 224 bytes and stores camera, model, light, and material values. Call `material.writeUniforms({ viewProjection, model, cameraPosition, light })` before drawing. You may also pass `baseColor`, `metallic`, or `roughness` to override the factory values for that upload.

`PbrMaterialSpec` is the input object shape for `pbrMaterial`: it includes `device`, `baseColor`, optional `metallic`, optional `roughness`, and optional `targetFormat`.

`targetFormat` (optional, default `'bgra8unorm-srgb'`): the color attachment format the pipeline writes into. Pick `'rgba8unorm-srgb'` on platforms that don't support BGRA-srgb (e.g. some compatibility-mode backends). Both formats apply linear→sRGB encoding on store, so the shader continues to write linear values regardless.

Materials are cached per device and parameter set. Calling `pbrMaterial` again with the same device, `baseColor`, `metallic`, `roughness`, and `targetFormat` returns the same object.
