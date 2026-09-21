export const meta = {
  slug: "depth-estimation",
  title: "Depth Estimation",
  description:
    "Estimate depth from a photo or webcam with ONNX Runtime Web on WebGPU. Shade its GPU-resident output beside the input through a zero-copy vgpu buffer wrap.",
  tags: ["machine-learning", "onnx", "depth-estimation", "shader"],
  capabilities: [
    "webgpu",
    "machine-learning",
    "external-device",
    "zero-copy",
    "gpu-buffer-interop",
    "storage-buffers",
    "compute-shader",
    "camera-input",
    "select-control",
    "demand-rendering",
    "responsive-canvas",
  ],
  files: [
    "index.tsx",
    "renderer.ts",
    "ort-runtime.ts",
    "ort-webgpu.ts",
    "scheduling.ts",
    "side-by-side.wgsl",
    "reduce-range.wgsl",
  ],
} as const;
