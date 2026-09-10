---
"@vgpu/adapter-node": minor
---

Default Node/Linux rendering to Vulkan even when X11 or Wayland is available, avoiding Dawn's known restricted-mip-view/storage-write defect in OpenGL. The existing compatibility feature level is unchanged. macOS, Windows and browser backend defaults are unchanged.

Linux installations that previously relied on automatic OpenGL selection now need a usable Vulkan driver or an installed portable CPU renderer (`npx vgpu install-software-renderer`). Auto mode retains the installed CPU-renderer fallback and actionable errors; it does not silently fall back to OpenGL or download drivers. Explicit OpenGL/Dawn-flag overrides remain supported, with the upstream limitation documented.

Repository Docker GPU tests and visual references use Vulkan/lavapipe. No Dawn dependency update or native patch is required.
