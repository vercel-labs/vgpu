# createMockAdapter

`createMockAdapter()` returns a pure-JavaScript `VGPUAdapter`. Its devices allocate
in-memory buffers backed by `Uint8Array`, making the core seam testable without Dawn
or native GPU libraries.
