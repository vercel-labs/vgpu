# @vgpu/wgsl-std

Pure WGSL utility snippets for use with `@vgpu/wgsl` import resolution.

This package intentionally ships raw `.wgsl` modules instead of JavaScript wrappers or a macro/include system. Import the explicit utility area you need:

```wgsl
import { identityF32 } from "@vgpu/wgsl-std/math";
import { identityVec3f } from "@vgpu/wgsl-std/color";
```

There is no root WGSL export. Subpath exports resolve to physical WGSL files:

- `@vgpu/wgsl-std/math` -> `src/math/index.wgsl`
- `@vgpu/wgsl-std/color` -> `src/color/index.wgsl`

The scaffold currently includes only tiny identity helpers to prove resolver mechanics. Future slices will replace or expand these modules with the reviewed math and color utility catalog.

WGSL snippets in this package must stay pure declaration modules: functions, constants, structs, and aliases only. They must not introduce hidden bindings, resource variables, overrides, or entry points.
