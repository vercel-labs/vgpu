# three-tsl

Imports WGSL modules with `wgslVitePlugin({ minify: true })` from `vgpu/client`,
then adapts their exported functions into three.js TSL nodes with
`tslExports` from `vgpu/three`. Those nodes drive a procedural
`MeshPhysicalNodeMaterial` lava demo.

See the [three.js integration guide](https://vgpu.sh/docs/guides/threejs) for
the focused setup and API walkthrough.

![Lava preview](./previews/lava.png)

The preview is rendered headless in Node by `pnpm previews`
(`scripts/generate-previews.ts`): `vgpu/node` creates the Dawn-backed WebGPU
device, three's `WebGPURenderer` receives that same `GPUDevice` (plus stub
canvas/context and a handful of browser-global shims), and the frame is read
back from a `RenderTarget` through an output-transform-only chain — no browser
involved.
The environment needs a Vulkan ICD for Dawn (see `@vgpu/adapter-node`'s
system requirements: `VK_ICD_FILENAMES`, `XDG_RUNTIME_DIR`,
`VGPU_DAWN_FLAGS=backend=vulkan`).

```
src/noise.wgsl         shared value/fbm noise plus bake-only periodic 2D noise
src/lava.wgsl          heat, crust, sink, and blackbody fields; uses
                       @vgpu/wgsl-std voronoi3d + noise.wgsl
src/lava-material.ts   physical material: emissive cracks, bump normals, and
                       vertex relief all driven by lava.wgsl
src/scenes.ts          shared scene/lights/mesh builders
src/object-drag-controls.ts  damped object rotation with a fixed render camera
src/main.ts            lava scene (sphere by default, lil-gui mesh picker), WebGPURenderer
src/bake-lava.ts       one-time field-volume + seamless detail texture bakes
src/harness.ts         offscreen render smoke check (also runs headless)
scripts/generate-previews.ts  headless preview renders on vgpu/node (Dawn)
scripts/field-viz.ts          renders lava.wgsl fields to PNGs with pure vgpu
```

## Run

```bash
pnpm install
pnpm --filter @vgpu/example-three-tsl dev
```

Open the printed URL in a WebGPU-capable browser.

## The lava material

Everything procedural lives in `lava.wgsl` and flows into the material as
TSL nodes:

- `lavaGlow` — the full glow composition as `vec2f(heat, meltMask)`:
  variable-width incandescent cracks along fbm-warped voronoi plate
  boundaries (`f2 - f1` from `@vgpu/wgsl-std/noise`); melt washes flanking
  the channels, textured by `meltSkin` — a Substance-style cooling-skin
  field (anisotropic streak noise under perlin directional warps, soft like
  a blurred mask) whose filled-in bands drop the heat AND carve out of the
  liquid mask, so cooled skin shades as rock again — plus white-hot contact
  rims at wash edges and around floating crust islands; and a fringe over
  solid crust — a wide thermal gradient toward the melt plus ember speckle
  seeping through the micro grain. The skin field embosses the melt
  normals; the rock never carries these lines.
- `blackbody` — incandescence ramp (black → deep red → orange → yellow-white)
  feeding `emissiveNode` with HDR intensity under ACES tone mapping.
- `crustHeight` — plate relief plus pahoehoe rope folds on lobe patches,
  clinkery rubble elsewhere, and clustered vesicle pits. Its smooth register
  comes from the field volumes; sharp scabs, seams, vesicle pits, mineral
  grain, flow streaks, and their gradients come from two seamless mipmapped
  `RGBA16F` tiles sampled triplanarly. This replaces the live sharp register's
  nine Voronoi evaluations and clustered fBm with three filtered texture taps.
- `crustSurface` — one `vec4f` of shading masks (tone mottling, oxide
  staining, glassy-skin mask, vesicle pits) driving albedo, roughness
  variation, and a clearcoat "volcanic glass" sheen.
- `lavaSink` — a wide low-frequency channel mask for `positionNode` vertex
  displacement, kept separate from the thin cracks so coarse meshes don't
  stipple.

- `crustPbr` — a fourth `vec4f` of PBR masks: cavity occlusion (`aoNode`),
  iridescence patches of the glassy skin (`iridescenceNode` + IOR +
  thickness), specular-intensity mottling (`specularIntensityNode`), and
  glinting mineral facets (`metalnessNode`). The clearcoat also gets its own
  smoother `clearcoatNormalNode` — the frozen glass skin drapes over the
  plates but not the mineral grain. In total the material feeds twelve
  `MeshPhysicalNodeMaterial` slots from WGSL: color, emissive, roughness,
  metalness, ao, normal, clearcoat, clearcoat roughness, clearcoat normal,
  specular intensity, iridescence (+IOR/thickness), and position.

Lighting is image-based: a CC0 Poly Haven night HDRI (via `@pmndrs/assets`)
drives `scene.environment` and the backdrop, plus a cool moonlight key and a
faint warm floor bounce standing in for the glow lighting the crust back.
The interactive lava scene renders directly to the WebGPU canvas, without a
bloom or fullscreen post-processing pass. ACES tone mapping still runs as the
renderer output transform. The render camera stays fixed. Three's object-native
DragControls supplies stable mouse/touch rotation, while the displayed
quaternion eases toward the dragged target. Automatic rotation is time-based,
so its speed is stable across different frame rates.

Note on the harness: rendering straight into a `RenderTarget` skips tone
mapping and sRGB encoding (three treats targets as linear intermediates),
while the offscreen `PostProcessing` helper bakes the full output transform —
so harness screenshots match the on-screen image only on the post path
(`?post=0` reads back linear and darker).

## How the bridge works

- `wgslVitePlugin({ minify: true })` from `vgpu/client` resolves each imported
  WGSL graph before Vite emits it.
- `import lavaModule from "./lava.wgsl"` returns the complete
  `{ version: 1, wgsl, functionExports }` artifact. `functionExports` preserves
  authored export and parameter names while mapping each export to its final
  `resolvedName`, so identifier minification remains safe.
- `tslExports<LavaExports>(lavaModule)("lavaGlow", "blackbody")` selects exports by their
  authored names, reads their final signatures, and emits a `wgslFn` forwarding
  wrapper for each one. All wrappers share one `wgsl()` include for the module.
- The returned nodes are callable with inputs keyed by WGSL parameter names.
  TSL uniforms flow in as plain function parameters — three owns the actual
  `@group/@binding` layout when it builds the shader:

```ts
import type { Node } from "three/webgpu";
import { positionLocal, time, uniform } from "three/tsl";
import { tslExports } from "vgpu/three";
import lavaModule from "./lava.wgsl";

type LavaExports = {
  lavaGlow: { position: Node; t: Node };
  blackbody: { t: Node };
};

const { lavaGlow, blackbody } = tslExports<LavaExports>(lavaModule)(
  "lavaGlow",
  "blackbody",
);
const glowIntensity = uniform(2.4);
material.emissiveNode = blackbody({ t: lavaGlow({ position: positionLocal, t: time }).x }).mul(glowIntensity);
```

Pass the complete loader artifact to `tslExports`, never only
`lavaModule.wgsl`: the string drops the minification-safe export metadata.

Entry points and functions that touch `@group/@binding` resources do not map
to `wgslFn` — TSL manages bindings itself. Pure functions (like everything in
`@vgpu/wgsl-std`) are the sweet spot.

## Tests

`pnpm --filter @vgpu/example-three-tsl test` checks that the real, minified
`lava.wgsl` loader artifact adapts through the public `vgpu/three` API, then
covers the periodic bake contracts and scene behavior used by the demo.

`/harness.html` (dev server) renders the material into a `RenderTarget` with a
stubbed canvas context and reports lit/distinct pixel counts on
`window.__result` — usable from headless chromium where WebGPU canvas
presentation is unavailable (`--enable-unsafe-webgpu --enable-features=Vulkan
--use-vulkan=swiftshader --in-process-gpu`).
