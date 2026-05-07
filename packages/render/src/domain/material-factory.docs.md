# `material()` factory

`material()` builds a render `Material` from WGSL vertex and fragment source. It injects a uniform struct when the schema has fields, creates the shader module, creates a render pipeline, allocates one uniform buffer, and returns a material with `writeUniforms()` plus raw GPU objects under `.gpu` for advanced use.

## Uniform schema

Pass `uniforms` as an object where each key is the field name used by the shader and each value is a supported WGSL type. The supported types are `f32`, `u32`, `i32`, `vec2f`, `vec3f`, `vec4f`, `vec2u`, `vec3u`, `vec4u`, `vec2i`, `vec3i`, `vec4i`, `mat3x3f`, and `mat4x4f`.

The name `uniforms` is reserved because the factory creates a variable with that name. An empty schema is allowed. With an empty schema the factory does not inject the `Uniforms` struct or binding, and `uniformByteSize` is `0`.

Uniform byte layout follows WGSL alignment rules. Scalars align to 4 bytes, `vec2` values align to 8 bytes, `vec3` and `vec4` values align to 16 bytes, `mat3x3f` occupies 48 bytes, and `mat4x4f` occupies 64 bytes. The final struct size is rounded up to at least 16-byte alignment so `{ time: 'f32' }` has `uniformByteSize === 16`.

## Vertex layouts

Choose one `vertexLayout` value:

- `position-only`: location 0 is `vec3<f32>`, stride 12 bytes.
- `position-normal`: location 0 is position and location 1 is normal, stride 24 bytes.
- `position-normal-uv`: location 0 is position, location 1 is normal, and location 2 is uv, stride 32 bytes.
- `position-uv`: location 0 is position and location 1 is uv, stride 20 bytes.

## WGSL conventions

When the schema is not empty, the factory injects this binding before your shader source:

```wgsl
struct Uniforms {
  fieldName: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
```

Your shader reads fields as `uniforms.fieldName`. Provide `vs_main` and `fs_main` entry points.

## Example

```ts
const mat = material({
  device,
  vertexLayout: 'position-only',
  uniforms: { time: 'f32' },
  vertex: `
struct VertexIn { @location(0) position: vec3<f32> };
@vertex fn vs_main(in: VertexIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(in.position, 1.0);
}`,
  fragment: `
@fragment fn fs_main() -> @location(0) vec4<f32> {
  let pulse = 0.5 + 0.5 * sin(uniforms.time);
  return vec4<f32>(pulse, 0.2, 1.0 - pulse, 1.0);
}`,
});

mat.writeUniforms?.({ time: performance.now() / 1000 });
```

## `writeUniforms()`

`writeUniforms()` is strict. Pass every uniform on every call, and make the keys match the schema exactly. A missing key or an extra key throws `VGPU-CORE-INVALID-USAGE`. Values can be numbers, arrays, or typed arrays. Matrix values are passed in column-major order.
