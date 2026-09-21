export const meta = {
  slug: "mnist-classifier",
  title: "MNIST Classifier",
  description:
    "Draw a digit and classify it with ONNX Runtime Web on WebGPU. Render the GPU-resident logits through a non-owning vgpu buffer wrap.",
  tags: ["machine-learning", "onnx", "mnist", "shader"],
  capabilities: [
    "webgpu",
    "machine-learning",
    "external-device",
    "zero-copy",
    "gpu-buffer-interop",
    "storage-buffers",
    "pointer-input",
    "demand-rendering",
    "responsive-canvas",
  ],
  files: [
    "index.tsx",
    "renderer.ts",
    "ort-runtime.ts",
    "ort-webgpu.ts",
    "preprocess.ts",
    "visualize.wgsl",
  ],
} as const;
