# BindGroup

`BindGroup` is an opaque wrapper around `GPUBindGroup`. It gives the render
package a stable public handle for resource bindings, even when the caller
creates the underlying bind group directly through WebGPU.

Public shape:

- `new BindGroup(gpu)` stores the raw WebGPU bind group.
- `.gpu` exposes that raw `GPUBindGroup` for low-level escape hatches.
- `dispose()` is currently a no-op because WebGPU bind groups do not have a
  destroy method.

Invariants: `BindGroup` does not create layouts, validate bindings, or own GPU
resources. It is a lightweight handle around an existing `GPUBindGroup`.

Example:

```ts
const raw = device.gpu.createBindGroup({ layout, entries });
const bindGroup = new BindGroup(raw);
renderPass.gpu.setBindGroup(0, bindGroup.gpu);
```
