# createMockAdapter

`createMockAdapter()` returns a pure-JavaScript `VGPUAdapter`. Its devices allocate
in-memory buffers backed by `Uint8Array`, making core testable without Dawn or native
GPU libraries.
