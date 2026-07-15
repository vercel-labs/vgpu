# normalDebugMaterial

Renders each fragment colored by its surface normal, which is useful for
verifying mesh normals visually during development.

```ts
import { box } from "vgpu/scene";
import { normalDebugMaterial } from "@vgpu/render/inspect";

const mesh = gpu.mesh(box({ size: 1 }));
const material = normalDebugMaterial({ device: gpu.device });
```

Each fragment outputs `(normal + 1) / 2` as RGB, mapping the unit-cube normal
range `[-1, +1]³` to `[0, 1]³`. A face whose normal points along +X reads pure
red; +Y reads pure green; +Z reads pure blue. Reverse directions read cyan,
magenta, and yellow.

The pipeline uses `triangle-list` topology with depth testing and back-face
culling. Default `targetFormat` is `'bgra8unorm-srgb'`; use
`'rgba8unorm-srgb'` on platforms that require it.

Normals are passed through in object space. Applying a rotation in `modelMatrix`
rotates the visualized colors with the geometry, which is the intended behavior
for this inspector. A normal matrix is not applied; this is a development
visualization, not a lighting pass.
