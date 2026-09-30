---
"@vgpu/wgsl": patch
"vgpu": patch
---

## Summary

Reduce repeated shader metadata in ordinary WGSL loader output with bounded private tables and, where the bundler graph permits, independently reachable metadata modules. Keep parser-free prepared ShaderSource v2 values and existing imports and loader configuration. Update the bundled loader documentation to describe compact emission and rebuild diagnostics. When an import names a missing WGSL file, `resolveShader()` now reports the missing candidate paths through its existing `onDependency` callback before `VGPU-WGSL-RES-NOTFOUND`, so Vite and webpack watch builds rebuild once the file is restored; successful dependency reporting is unchanged.

## Migration

None: Author imports and loader configuration, public prepareShader output, and the ShaderSource v2 data contract are unchanged. Rebuild through the existing loader to receive compact metadata; no source changes are required. Resolution errors and successful dependency notifications are unchanged; the extra missing-path notifications occur only immediately before an unresolved import throws.
