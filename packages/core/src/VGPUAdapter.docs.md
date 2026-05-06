# VGPUAdapter

`VGPUAdapter` is the seam interface implemented by concrete adapters. Core asks an
adapter for a `Device` and does not know whether the implementation is Dawn-backed,
browser-backed, or pure JavaScript mock memory.
