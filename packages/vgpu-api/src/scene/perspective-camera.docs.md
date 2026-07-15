# `perspectiveCamera`

Creates a pure camera object with `viewProjection` and `position`. FOV is in degrees for the public scene API.

```ts
import { perspectiveCamera } from "vgpu/scene";

const cam = perspectiveCamera({ fov: 60, aspect: gpu.screen!.size[0] / gpu.screen!.size[1], position: [0, 2, 4], target: [0, 0, 0] });
```
