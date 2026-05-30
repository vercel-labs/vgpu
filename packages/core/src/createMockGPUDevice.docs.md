# createMockGPUDevice

`createMockGPUDevice()` creates the in-memory WebGPU-shaped object used by the mock
adapter. It is public so `@vgpu/adapter-mock` can expose the same adapter contract as
other adapters while keeping mock storage logic local to core tests.

The mock device exposes stable, plausible `limits` and a setlike `features` object
so tests can exercise capability inspection through `Device.limits` and
`Device.features`. Optional features are not enabled by default.
