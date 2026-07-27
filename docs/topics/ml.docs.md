---
title: Overview
summary: Share one GPUDevice between vgpu and a machine learning runtime so model outputs stay on the GPU.
websitePath: /ml
relatedSymbols: [init, Device, Buffer]
---

# Overview

Share one `GPUDevice` between vgpu and a machine learning runtime so model outputs stay on the GPU.

The `init({ device })` option adopts a `GPUDevice` that another library created. Use it when an ML runtime such as ONNX Runtime Web already owns a WebGPU device and you want vgpu shaders to consume the model's output buffers without a CPU roundtrip. The API is model-agnostic: vision, diffusion, embedding, or LLM outputs are all just `GPUBuffer`s to vgpu.

vgpu never takes ownership of an adopted device. `gpu.dispose()` releases the resources vgpu created, but it never calls `device.destroy()` on a device it did not request.

DRAFT PROSE PENDING AUTHOR
