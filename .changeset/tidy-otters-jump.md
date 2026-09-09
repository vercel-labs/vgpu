---
"vgpu": patch
---

`draw()` and `effect()` now prefer a declared `fs_main` when a shader contains several fragment entry points, instead of silently selecting an earlier fragment in source order. Shaders without `fs_main` keep their first-fragment default, and vertex and compute selection remain first-in-stage.
