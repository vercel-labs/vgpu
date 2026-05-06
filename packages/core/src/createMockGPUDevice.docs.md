# createMockGPUDevice

`createMockGPUDevice()` creates the in-memory WebGPU-shaped object used by the mock
adapter. It is public so `@vgpu/adapter-mock` can expose the same adapter contract as
other adapters while keeping mock storage logic local to core tests.
