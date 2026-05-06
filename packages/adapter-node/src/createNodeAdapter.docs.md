# createNodeAdapter

`createNodeAdapter()` returns a Dawn-backed `VGPUAdapter` using `webgpu@0.4.0`.
That version is pinned because upstream added `dist/linux-arm64.dawn.node`, which
lets the S1 seam use the official Dawn prebuilt binary. On Linux the adapter uses
the OpenGL software backend by default (`backend=opengl` plus Dawn compatibility
feature level) and keeps a process-wide singleton GPU instance; conflicting later
flags are warned and ignored because Dawn re-init can SIGSEGV.
