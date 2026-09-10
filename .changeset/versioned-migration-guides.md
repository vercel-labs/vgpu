---
"vgpu": patch
"@vgpu/cli": patch
---

## Summary

Bundle versioned consumer migration guides in the local docs CLI and MCP corpus. Discover them with `vgpu docs ls /migrations` and read a guide with `vgpu docs cat /migrations/0.5.0.docs.md`. Collect migration instructions from changesets during release preparation instead of relying on standalone repository files.

## Migration

None: adds discoverable documentation without changing existing consumer APIs or CLI commands.
