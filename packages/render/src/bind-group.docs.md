# BindGroup

`BindGroup` is an opaque wrapper around `GPUBindGroup`. It exists in S2 so the
render package already has a stable public place for binding handles, even though
the hello-triangle tracer bullet does not need resources or layouts.

Public shape:

- `new BindGroup(gpu)` stores the raw WebGPU bind group.
- `.gpu` exposes that raw `GPUBindGroup` for low-level escape hatches.
- `dispose()` is currently a no-op because WebGPU bind groups do not have a
  destroy method.

Invariants: `BindGroup` does not create layouts, validate bindings, or own GPU
resources in S2. Future seams can deepen the module by adding construction
helpers without changing the handle object used by render passes.

Example:

```ts
const raw = device.gpu.createBindGroup({ layout, entries });
const bindGroup = new BindGroup(raw);
renderPass.gpu.setBindGroup(0, bindGroup.gpu);
```
