# Pipeline

Opaque render pipeline created by `createRenderPipeline(device, options)`. It
wraps `GPURenderPipeline` and exposes `.gpu` for low-level WebGPU escape hatches.
S2 supports only the fields needed for a plain WGSL hello triangle.
