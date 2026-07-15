# `Camera`, `Mat4`, and `Vec3`

Scene camera helpers are plain data, not a scene graph. Shaders declare a camera struct and `set()` receives matrices by name.

```ts
import { perspectiveCamera } from "vgpu/scene";
const cam = perspectiveCamera({ fov: 45, position: [2, 2, 3], target: [0, 0, 0] });
cube.set({ camera: { viewProjection: cam.viewProjection } });
```
