---
title: Use WGSL modules in three.js TSL
summary: Turn pure functions from vgpu-resolved WGSL modules into callable three.js TSL nodes with the vgpu/three adapter.
keywords: three.js, threejs, tsl, three shader language, node material, meshphysicalnodematerial, webgpurenderer, wgslfn, tslExports, wgsl modules
relatedSymbols:
  - tslExports
  - TslExportsErrorCode
  - ShaderSource
  - ShaderFunctionExport
---

# Use WGSL modules in three.js TSL

vgpu can resolve a reusable WGSL module graph, and three.js TSL can call WGSL functions from node materials. `tslExports()` connects those pieces without taking ownership of your renderer, scene, materials, or render loop.

Use this integration when you want to author shader logic as portable WGSL modules while three.js continues to own bindings and shader entry points.

## Install

```sh
npm install vgpu three@^0.180.0
npm install --save-dev @types/three@^0.180.0 vite typescript
```

`vgpu` includes its WGSL resolver and bundler loaders, so the application does not need to install `@vgpu/wgsl` separately. The adapter loads Three only when you import `vgpu/three`.

## Configure Vite

<!-- test:three-tsl-vite-config -->
```ts
// vite.config.ts
import { wgslVitePlugin } from "vgpu/client";

export default {
  plugins: [wgslVitePlugin({ minify: true })],
};
```

`minify: true` enables whitespace and safe identifier minification. The loader keeps the authored names needed by `tslExports()` in the complete shader artifact even when the emitted WGSL uses shorter identifiers.

Type `.wgsl` imports through the client entry point:

```text
// src/vgpu-env.d.ts
/// <reference types="vgpu/client" />
```

For webpack and Turbopack configuration, see [Using vgpu with Next.js and other bundlers](nextjs.docs.md).

## Export pure WGSL functions

Write ordinary helper functions, then mark only the functions you want JavaScript to address with `export`:

<!-- test:three-tsl-surface-wgsl -->
```wgsl
// surface.wgsl
import { perlin3d } from "@vgpu/wgsl-std/noise/perlin";

fn surfaceField(position: vec3f, timeSeconds: f32) -> f32 {
  let samplePosition = position * 2.0 + vec3f(0.0, 0.0, timeSeconds * 0.1);
  return perlin3d(samplePosition) * 0.5 + 0.5;
}

export fn surfaceColor(position: vec3f, timeSeconds: f32) -> vec3f {
  let value = surfaceField(position, timeSeconds);
  return mix(vec3f(0.04, 0.01, 0.08), vec3f(1.0, 0.25, 0.02), value);
}

export fn surfaceRoughness(position: vec3f, timeSeconds: f32) -> f32 {
  return 0.25 + surfaceField(position, timeSeconds) * 0.55;
}
```

These are library functions, not `@vertex`, `@fragment`, or `@compute` entry points. They receive values through parameters, return a value, and declare no `@group` or `@binding` resources. Three remains responsible for the generated shader stages and bind groups.

A module does not need an import to participate. A leaf containing `export fn` goes through the same resolver path, so the loader removes the author-only `export` marker and records its public function identity.

## Create callable TSL nodes

Pass the complete `.wgsl` import to `tslExports()` and request the authored export names you need:

<!-- test:three-tsl-material -->
```ts
import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import { positionLocal, time } from "three/tsl";
import { tslExports } from "vgpu/three";
import surfaceModule from "./surface.wgsl";

type SurfaceInputs = {
  position: Node;
  timeSeconds: Node | number;
};

type SurfaceExports = {
  surfaceColor: SurfaceInputs;
  surfaceRoughness: SurfaceInputs;
};

const { surfaceColor, surfaceRoughness } = tslExports<SurfaceExports>(
  surfaceModule,
)("surfaceColor", "surfaceRoughness");

const inputs = {
  position: positionLocal,
  timeSeconds: time,
};

const material = new THREE.MeshPhysicalNodeMaterial();
material.colorNode = surfaceColor(inputs);
material.roughnessNode = surfaceRoughness(inputs);
```

Each returned function accepts one object keyed by the authored WGSL parameter names. Values can be Three TSL nodes or JavaScript numbers, matching `wgslFn()`.

Request functions that share a material with one selector call. `tslExports(surfaceModule)` creates one shared `wgsl()` include for the resolved module; its selector creates one small forwarding function for each positional export name.

## Add a manual TypeScript contract

The positional export names give the returned object typed properties, but a normal `.wgsl` import does not carry a file-specific TypeScript signature. By default, each callable therefore accepts any named object of Three nodes or numbers.

Defining a manual contract next to each `tslExports()` call, as in the primary example above, is the recommended practice for application code and examples. TypeScript then checks selected names and input objects against the contract you wrote. For example, omitting `timeSeconds` from the `surfaceColor()` call above becomes a type error.

The contract is a compile-time assertion; TypeScript does not compare it with the WGSL. A contract may describe the complete module while a selector requests only the subset it needs. TypeScript rejects a selected name outside the contract and does not expose unselected keys, but it cannot prove that a contract name exists in the shader. Three's general `Node` type also does not prove WGSL distinctions such as `f32` versus `vec3f`. The shader artifact and Three's shader builder remain the runtime authorities.

Use literal positional names as shown above. If names already live in an array, declare it `as const` and spread it into the selector so TypeScript preserves the exact returned keys. A union-valued name produces a union of possible result objects; narrow it with a property check such as `"surfaceColor" in selected` before calling that property.

## Keep the complete artifact

Pass `surfaceModule`, not `surfaceModule.wgsl`:

```ts
import { tslExports } from "vgpu/three";
import surfaceModule from "./surface.wgsl";

// Correct: keeps exported-function identity produced by the loader.
const { surfaceColor } = tslExports(surfaceModule)("surfaceColor");

// Avoid: this drops the resolver's authored-to-minified references.
const { surfaceColor: broken } = tslExports(surfaceModule.wgsl)("surfaceColor");
```

Identifier minification is fully supported when you pass the full artifact. The resolver records each authored export name, its authored parameter names, and the corresponding declaration name in the minified WGSL. Passing only the emitted string discards those references; that compatibility path is limited to hand-written or legacy WGSL whose identifiers have not changed.

## Export boundaries

Only direct `export fn` declarations in the resolved graph become addressable:

- Private `fn` helpers are included when needed but cannot be requested from a new loader artifact.
- Import aliases affect WGSL call sites; they do not create new public export names.
- Two reachable modules may both directly export the same authored name, but requesting that name is ambiguous. Add one uniquely named forwarding export for the Three-facing API.
- Re-export syntax is not supported.
- Top-level declarations whose names start with `_vgpu_three_` are reserved for the adapter's private forwarding functions.
- Functions must return a value. Void functions, shader entry points, resource-owning modules, and parameter or return forms that Three's `wgslFn()` cannot represent are unsupported.
- Global `enable`, `requires`, and `diagnostic` directives are unsupported because Three emits `wgsl()` includes after its own global declarations. An `@diagnostic(...)` attribute is not a module directive and is not rejected by this check; the adapter's other signature constraints still apply.

## Errors

`tslExports()` throws an error with a stable `code` when it cannot create the requested callable. Match `error.code`; no adapter-specific error class or `instanceof` contract is exported. Import the type-only `TslExportsErrorCode` union from `vgpu/three` when a helper accepts or exhaustively handles these codes.

| Code | Meaning | Fix |
| --- | --- | --- |
| `VGPU-THREE-TSL-EXPORT-NOT-FOUND` | No surviving direct export has the requested authored name. | Fix the name, add `export` to the declaration, or ensure an entry-point graph did not prune it. |
| `VGPU-THREE-TSL-EXPORT-AMBIGUOUS` | More than one surviving direct export has that authored name. | Add a uniquely named Three-facing forwarding export. |
| `VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED` | The function cannot be forwarded, or the module contains a global WGSL directive. | Use a pure value-returning function with `wgslFn()`-compatible parameters and no global `enable`, `requires`, or `diagnostic` directive. `@diagnostic(...)` attributes are distinct from module directives. |
| `VGPU-THREE-TSL-SOURCE-INVALID` | Export metadata and the emitted WGSL disagree, the final declaration cannot be read, or source uses the private `_vgpu_three_` namespace. | Rename private-namespace declarations or rebuild the WGSL artifact with matching vgpu packages; report the mismatch if it persists. |

Errors thrown later by Three while building a material are left unchanged.

## Try the examples

Start with [Three.js WGSL modules](/examples/tsl-exports). Its source is intentionally small: one leaf WGSL module, one direct export, one `tslExports()` call, and one `MeshPhysicalNodeMaterial`.

The advanced [Lava material](/examples/three-tsl) example uses the same adapter for a larger set of material inputs and for functions that pre-bake field volumes.

Both examples keep a manual TypeScript contract beside each `tslExports()` call. Follow that pattern when adding or changing WGSL exports so TypeScript checks selections and input objects against the nearby contract; keep the contract aligned with the shader, which remains the runtime authority.

In a checkout of this repository:

```sh
pnpm --filter @vgpu/example-three-tsl test
pnpm --filter @vgpu/example-three-tsl dev
```

## See also

- [`tslExports` API reference](/reference/vgpu-three/tsl-exports#tslexports) — signature, accepted sources, return value, and error contract.
- [WGSL modules](/concepts/wgsl-modules) — imports, direct exports, purity, mangling, and graph emission.
- [Using vgpu with Next.js and other bundlers](nextjs.docs.md) — webpack, Turbopack, Vite, and `.wgsl` TypeScript setup.
- [Three.js WGSL modules](/examples/tsl-exports) — the smallest working adapter example.
- [Lava material](/examples/three-tsl) — a complete material and baking workflow.
