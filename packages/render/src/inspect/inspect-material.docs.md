# InspectMaterial

`InspectMaterial` is the low-level material shape used by the inspect sub-export. It contains a pipeline, a group-0 bind group layout, and a typed uniform writer.

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

`writeUniforms` writes the matrix data and any material-specific values into the buffer. This keeps inspect materials independent from the PBR material path used by `RapidRenderer`.

`InspectMaterialUniformParams` always includes `viewProjectionMatrix` and `modelMatrix`. Individual inspect materials may capture defaults or read extra fields as needed.
