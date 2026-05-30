# createNodeAdapter

`createNodeAdapter()` returns a Dawn-backed `VGPUAdapter` using `webgpu@0.4.0`.
That version is pinned because upstream added `dist/linux-arm64.dawn.node`, which
lets this adapter use the official Dawn prebuilt binary. On Linux the adapter uses
the OpenGL software backend by default (`backend=opengl` plus Dawn compatibility
feature level) and keeps a process-wide singleton GPU instance; conflicting later
flags are warned and ignored because Dawn re-init can SIGSEGV.

On Linux, the `webgpu@0.4.0` Dawn linux-arm64 prebuild may require GLIBC 2.38+
when the native binary is loaded. Debian 12/bookworm (GLIBC 2.36) and similar
hosts can fail with `/lib/aarch64-linux-gnu/libc.so.6: version 'GLIBC_2.38' not
found`. This is a native environment compatibility issue, not a shader or
rendering issue. Use the pinned Docker test environment (`pnpm test:docker`) or
another Node 22 host based on Debian trixie, Ubuntu 24.04+, or equivalent GLIBC
2.38+ runtime.

For headless/software rendering, match the Docker environment variables
`LIBGL_ALWAYS_SOFTWARE=1`, `DISPLAY=:99`, and
`XDG_RUNTIME_DIR=/tmp/xdg-runtime`. `VGPU_DAWN_FLAGS` may be set to
space-separated Dawn flags, such as `VGPU_DAWN_FLAGS=backend=opengl`, and
replaces the adapter's default backend flag selection.
