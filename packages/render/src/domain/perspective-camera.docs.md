# perspectiveCamera

Creates a pure camera value for perspective projection.

Pass a vertical field of view in radians, aspect ratio, near and far planes, and a world-space `position` and `target`. The optional `up` vector defaults to `[0, 1, 0]`.

```ts
import { degToRad, perspectiveCamera } from "@vgpu/render";

const camera = perspectiveCamera({
  fovYRadians: degToRad(45),
  aspect: canvas.width / canvas.height,
  near: 0.1,
  far: 100,
  position: new Float32Array([0, 0, 5]),
  target: new Float32Array([0, 0, 0]),
});
```

The matrix is computed once as projection times view and stored on `camera.viewProjectionMatrix`.
