# orthographicCamera

Creates a pure camera value for orthographic projection.

Pass the left, right, bottom, top, near, and far planes, plus a world-space `position` and `target`. The optional `up` vector defaults to `[0, 1, 0]`.

```ts
import { orthographicCamera } from "@vgpu/render";

const camera = orthographicCamera({
  left: -1,
  right: 1,
  bottom: -1,
  top: 1,
  near: 0.1,
  far: 100,
  position: new Float32Array([0, 0, 5]),
  target: new Float32Array([0, 0, 0]),
});
```

The matrix is computed once as projection times view and stored on `camera.viewProjectionMatrix`.
