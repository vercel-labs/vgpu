# `StorageBuffer`

Ring-0/ring-1 storage resource for compute and storage-driven rendering. Prefer `gpu.storage(bytes, access)` for the ring-1 facade.

```ts
const particles = gpu.storage(COUNT * 16, "read-write");
const sim = gpu.compute(SIM_WGSL, { set: { particles } });
sim.dispatch(Math.ceil(COUNT / 64));
```
