# Scene geometry and `gpu.mesh()`

Scene geometry is pure data until `gpu.mesh()` uploads it. Use `gpu.draw()` for every mesh-backed shader.

```ts
import { box } from "vgpu/scene";

const cubeMesh = gpu.mesh(box({ size: 1 }));
const cube = gpu.draw({ shader: LIT_WGSL, mesh: cubeMesh, targets: [gpu.screen!] });
```

There is no material factory or scene graph. Your WGSL declares resources; `set()` supplies values by name.

## Primitives

All primitives return pure descriptors that can be uploaded with `gpu.mesh(...)`:

```ts
import { capsule, cone, cylinder, disk, dodecahedron, fullscreenQuad, icosahedron, icosphere, octahedron, plane, ring, sphere, tetrahedron, torus } from "vgpu/scene";

const sky = gpu.draw({ shader: SKY_WGSL, mesh: gpu.mesh(fullscreenQuad()), vertices: 6 });
const planet = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(icosphere({ radius: 1, subdivisions: 3 })) });
const marker = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(torus({ radius: 0.75, tube: 0.08 })) });
const badge = gpu.draw({ shader: FLAT_WGSL, mesh: gpu.mesh(ring({ innerRadius: 0.3, outerRadius: 0.5 })) });

const library = [
  capsule({ radius: 0.25, height: 1.2 }),
  cone({ radius: 0.4, height: 1 }),
  cylinder({ radius: 0.4, height: 1 }),
  disk({ radius: 0.5 }),
  dodecahedron({ radius: 0.5 }),
  icosahedron({ radius: 0.5 }),
  octahedron({ radius: 0.5 }),
  plane({ width: 2, height: 2 }),
  sphere({ radius: 0.5 }),
  tetrahedron({ radius: 0.5 }),
];
```

## Types

- `SceneGeometry` is the union returned by every primitive descriptor.
- `SceneGeometryOfKind<K>` narrows a descriptor to one primitive kind.
- `SceneMesh` is the uploaded mesh shape accepted by `gpu.draw()`.
- Option types (`BoxOptions`, `CapsuleOptions`, `ConeOptions`, `CylinderOptions`, `DiskOptions`, `FullscreenQuadOptions`, `IcosphereOptions`, `PlaneOptions`, `PolyhedronOptions`, `RingOptions`, `SphereOptions`, `TorusOptions`) are the public descriptor inputs.

```ts
import { box, type BoxOptions, type SceneGeometry } from "vgpu/scene";

function unitBox(options: BoxOptions = {}): SceneGeometry {
  return box({ size: 1, ...options });
}
```
