---
title: LLM and neural network buffers
summary: Factual ORT WebGPU device and buffer integration matrix.
websitePath: /guides/llm-neural-networks
relatedSymbols: [init, Device, Buffer]
---

# LLM and neural network buffers

DRAFT PROSE PENDING AUTHOR

Pinned Node recipe matrix: Node 22, `webgpu@0.4.0`, `onnxruntime-web@1.27.0`, and vgpu/software renderer 0.1.6. The executable non-published recipe is `experiments/ort-init-device/node/recipe.mjs`.

DRAFT PROSE PENDING AUTHOR

| Platform | Mode | Public route | Required lifetime |
| --- | --- | --- | --- |
| Browser | Snapshot | `init({device})`; raw `gpu.gpu` encoder copy to `destination.gpu` | retain Tensor through submit/fence |
| Browser | Reference | `gpu.device.wrapBuffer(tensor.gpuBuffer)` | submit → `await gpu.device.queue.flush()` → wrapper dispose → Tensor dispose |
| Node | Snapshot | same raw route after the pinned user-side Dawn/ORT setup | retain Tensor through submit/fence |
| Node | Reference | same `wrapBuffer` route after the pinned user-side Dawn/ORT setup | submit → `await gpu.device.queue.flush()` → wrapper dispose → Tensor dispose |

DRAFT PROSE PENDING AUTHOR

```ts
const destination = gpu.device.createBuffer({ size: bytes, usage: ["storage", "copy_dst"] });
const encoder = gpu.gpu.createCommandEncoder();
encoder.copyBufferToBuffer(tensor.gpuBuffer, 0, destination.gpu, 0, bytes);
gpu.gpu.queue.submit([encoder.finish()]);
await gpu.device.queue.flush();
```

DRAFT PROSE PENDING AUTHOR

```ts
const source = gpu.device.wrapBuffer(tensor.gpuBuffer);
try {
  compute.set({ source, destination });
  compute.dispatch(workgroups);
  await gpu.device.queue.flush();
} finally {
  source.dispose();
  tensor.dispose();
}
```

DRAFT PROSE PENDING AUTHOR

vgpu does not import ORT, resolve ORT WASM assets, mutate Node globals, validate GPUBuffer provenance, interpret Tensor dtype/shape/layout, recover a lost device, or transfer ownership of the borrowed device/buffer.
