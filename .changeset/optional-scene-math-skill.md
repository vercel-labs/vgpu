---
"vgpu": patch
---

## Summary

Guide agents to consider an optional numerical library for quaternion interpolation, spatial
queries and procedural motion when using vgpu. The skill preserves existing project dependencies
and routes integration examples through the installed CLI's documentation.

## Migration

None: This adds optional skill guidance. Runtime APIs and dependencies are unchanged; applications
do not need to install `math` unless their own numerical requirements call for it.
