---
"@vgpu/adapter-node": patch
"@vgpu/cli": patch
---

Label the CPU software renderer fallback so the native Vulkan/XDG_RUNTIME_DIR startup lines stop reading as fatal errors. The Node adapter now prints one `vgpu: notice — …` block on stderr (once per process, after the adapter is known, so it lands below the native lines it explains) that names the selected CPU renderer, states that rendering continues normally, and says the Dawn/Vulkan loader/Mesa `error`/`Warning` lines above come from the driver stack and are harmless. The notice also covers runs where Dawn selects a CPU adapter directly, not just the consented portable-renderer retry; explicit `adapter: "software"` stays silent.
