---
"vgpu": patch
---

## Summary

Correct the compilation and render-bundle guides to query the preferred canvas format before surface creation and use the actual format of existing surfaces. Update examples to pre-warm and record with signatures outside frames, then render canvas content inside frames.

## Migration

None: This corrects bundled documentation examples to match existing format selection and frame requirements; runtime APIs, defaults, and behavior are unchanged.
