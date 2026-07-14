# `orthographicCamera`

Creates a pure orthographic camera object for shaders expecting a `viewProjection` matrix.

```ts
const cam = orthographicCamera({ left: -2, right: 2, bottom: -2, top: 2, position: [0, 0, 4], target: [0, 0, 0] });
```
