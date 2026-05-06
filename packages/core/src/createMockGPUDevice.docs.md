# createMockGPUDevice

`createMockGPUDevice()` creates the in-memory WebGPU-shaped object used by the mock
adapter. It is public only to let `@vgpu/adapter-mock` satisfy the same seam as real
adapters while keeping mock storage logic local to core tests.
