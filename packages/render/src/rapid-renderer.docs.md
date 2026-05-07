# RapidRenderer

`RapidRenderer` submits one draw to a target view. The renderer binds a material,
optionally binds a mesh, then draws either `vertexCount` or `mesh.vertexCount`.

```ts
material.writeUniforms({ viewProjection, model, cameraPosition, light });
await renderer.draw({ material, mesh, target, depthTarget });
await renderer.draw({ material, pipeline, target, vertexCount: 3 });
```

`material` is required. `pipeline` is an optional override; otherwise the renderer
uses `material.pipeline`. Call `material.writeUniforms()` before `draw()` when the
material has uniforms. The renderer does not write camera, transform, light, or
material parameters.

`clearValue` defaults to opaque black. `depthTarget` is optional. `renderer.gpu`
returns the raw `GPUDevice`. `draw()` resolves after command submission.
