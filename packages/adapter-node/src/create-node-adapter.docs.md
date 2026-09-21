# createNodeAdapter

`createNodeAdapter()` returns a Dawn-backed `VGPUAdapter` using the
`webgpu@0.4.0` API. The native loader resolves Dawn in this order:

1. the file named by `VGPU_DAWN_BINARY`;
2. a verified vgpu prebuild in the versioned user cache;
3. the stock `webgpu` package;
4. on Linux, a lazy download of the vgpu prebuild if stock Dawn cannot load.

A best-effort postinstall download normally fills the cache. It never fails npm
or pnpm installation, and the runtime retry covers `--ignore-scripts` and pnpm
configurations that block lifecycle scripts. Downloads come from the pinned
`vercel-labs/vgpu` GitHub Release and are accepted only when their SHA-256 equals
the hash pinned in `@vgpu/adapter-node`. Private-repository and draft-release
access honors `GH_TOKEN` or `GITHUB_TOKEN`; published public assets are fetched
without a token. Override the cache root with `VGPU_CACHE_DIR` (or
`XDG_CACHE_HOME`). Cache entries must be regular, non-symlink files. Before
native loading, the verified bytes are copied through one open file descriptor
into a private per-process directory and that exact private copy is loaded,
preventing cache replacement between verification and `require()`.

The portable prebuild currently supports Linux arm64 with glibc 2.31 or newer.
Linux musl, other Linux CPUs, and other operating systems continue to try stock
`webgpu`; errors identify an unsupported platform, musl, an offline/blocked
download, or the exact required and detected glibc versions. Manual and CI
installation is available with:

```sh
pnpm exec vgpu install-dawn
# or
npx vgpu install-dawn
```

`VGPU-NODE-PREBUILD-MISSING` includes the failed reason and those remediation
commands. `VGPU-NODE-PREBUILD-CHECKSUM` refuses a corrupt or substituted asset.
`VGPU-NODE-GLIBC-MISMATCH` names both versions when a selected native binary
cannot load. Do not upgrade a host's glibc in place; install the portable
prebuild or provide an audited binary with `VGPU_DAWN_BINARY`.

On Linux the adapter explicitly selects Vulkan by default, even when `DISPLAY`
or `WAYLAND_DISPLAY` is configured. No display server is required. The existing
compatibility feature level is unchanged. macOS/Windows backend selection and
browser WebGPU are unaffected. It keeps a process-wide singleton GPU instance;
conflicting later flags are warned and ignored because Dawn re-init can SIGSEGV.

Install a Vulkan driver for the hardware GPU, or use Mesa/lavapipe for CPU rendering.
For deterministic CI, select the software driver's ICD with `VK_ICD_FILENAMES`.
If discovery fails in auto mode, an already installed portable software renderer
can be used; otherwise `VGPU-NODE-NO-ADAPTER` explains how to install it with
`npx vgpu install-software-renderer`. There is no silent OpenGL fallback and no
automatic driver download. Hardware-only mode still rejects CPU adapters.

Explicit `backend: "opengl"`, `backendFlags`, and `VGPU_DAWN_FLAGS` overrides are
preserved. For example, `VGPU_DAWN_FLAGS=backend=opengl` opts into OpenGL, including
its known Dawn limitation: sampling a restricted mip view can corrupt later storage
writes to another mip of the same texture (upstream issue 392121637).
`VGPU_DAWN_FLAGS` accepts space-separated Dawn flags and replaces default selection.
Existing `backend: "webgpu"` keeps native discovery with the full WebGPU feature level.

A CPU Vulkan device is not necessarily a WebGPU fallback adapter. In current
Dawn builds lavapipe is acquired by the normal request; forcing
`forceFallbackAdapter` can exclude it. If no adapter is found after the retry
window, `VGPU-NODE-NO-ADAPTER` reports the request options and Dawn flags and
points to the Mesa version, Vulkan ICD, and display environment to inspect.

For agentic headless snapshot tests, pair this adapter with an explicit
offscreen `rgba8unorm` render target that includes `"copy_src"`, submit the
render commands, `await device.queue.flush()`, then read pixels through
`Texture.read()`. Keep PNG encoding and pixel comparison in project test tooling
(such as `pngjs`, `pixelmatch`, or existing snapshots), not in the VGPU API. See
`createNodeDevice` for a full native-before/VGPU-after guide.
