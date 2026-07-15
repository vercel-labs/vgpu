# `degToRad`

`degToRad(degrees)` converts degrees to radians for low-level math. Most public camera helpers accept degrees directly, but custom animation and shader parameter code often needs radians.

```ts
import { degToRad } from "vgpu/scene";

const angle = degToRad(45);
spin.set({ sinAngle: Math.sin(angle), cosAngle: Math.cos(angle) });
```
