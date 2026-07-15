# `srgb`

`srgb(r, g, b)` converts byte-style sRGB color channels into linear floating-point values for CPU-side constants.

```ts
import { srgb } from "vgpu/scene";

const albedo = srgb(255, 128, 64);
draw.set({ albedo });
```

Prefer explicit WGSL color management for post-processing passes; use this helper for scene constants and tests where CPU-side color literals are clearer.
