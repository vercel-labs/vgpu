---
"@vgpu/adapter-node": minor
---

## Summary

Default Node/Linux rendering to Vulkan, avoiding Dawn's restricted-mip-view/storage-write defect in OpenGL. macOS, Windows and browser defaults are unchanged; no Dawn update or native patch is required.

## Migration

### Affected usage

Node applications on Linux that relied on automatic OpenGL selection, including systems with X11 or Wayland. macOS, Windows and browser applications do not need this backend migration.

### Steps

Provide a usable Vulkan driver or install the portable CPU renderer with `npx vgpu install-software-renderer`. Auto mode retains the installed CPU-renderer fallback and actionable errors; it does not silently fall back to OpenGL or download drivers. Explicit OpenGL/Dawn-flag overrides remain supported, but retain the upstream restricted-mip-view/storage-write limitation. The compatibility feature level is unchanged.

### Verification

Run the project-local `vgpu doctor` and the application's GPU tests in the target Linux environment. Verify selected backend and storage writes/readback at nonzero mip levels. Test the installed CPU-renderer fallback separately if the deployment relies on it.
