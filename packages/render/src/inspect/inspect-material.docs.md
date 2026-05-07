# InspectMaterial

`InspectMaterial` is the low-level material shape used by the inspect sub-export.
It contains a pipeline, a group-0 bind group layout, and a typed uniform writer.

```ts
const uniforms = device.createBuffer({
  size: material.uniformByteSize,
  usage: ["uniform", "copy_dst"],
});

material.writeUniforms(uniforms.gpu, 0, {
  viewProjectionMatrix: camera.viewProjectionMatrix,
  modelMatrix,
});
```

`writeUniforms` writes the shared inspect matrices into the buffer. This keeps
inspect materials independent from application materials used by `RapidRenderer`.

`InspectMaterialUniformParams` includes `viewProjectionMatrix` and `modelMatrix`.
Future inspect materials should extend this interface explicitly if they need
additional uniform inputs.
