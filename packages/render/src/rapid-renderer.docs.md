# RapidRenderer

`RapidRenderer` submits one draw to a target view.

```ts
await renderer.draw({ pipeline, target, vertexCount: 3 });
await renderer.draw({ material, mesh, camera, target, depthTarget });
```

Without `material`, `pipeline` and `vertexCount` are required. With `material`,
`mesh`, `camera`, and `depthTarget` are required; missing values throw
`VGPU-CORE-INVALID-USAGE`. The material path uploads uniforms, binds them with a
dynamic offset, sets the mesh vertex buffer, and draws `mesh.vertexCount`.

`clearValue` defaults to opaque black. `transform` defaults to identity. `light`
defaults to white direction `[-0.4, -0.7, -0.6]`, intensity `1`; directions are
normalized and describe photon travel. `renderer.gpu` returns the raw
`GPUDevice`. `draw()` resolves after command submission.
