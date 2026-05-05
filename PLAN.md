# `vgpu` — Architecture Plan

> A modular, cross-runtime WebGPU library for shader rendering, 3D scenes, GPU tensors, LLM training/inference, and math visualization.

---

## Core Philosophy

One minimal, zero-dependency core (`@vgpu/core`) that owns the GPU abstraction layer. Every other capability — rendering, tensors, 3D scenes, math visualization, language tooling — is a separate package that extends core primitives. Nothing is mandatory. You bring what you need.

The runtime adapter pattern ensures `@vgpu/core` and all capability packages contain **zero platform code**. They never import from `navigator`, `window`, `document`, or `fs` directly. All of that lives in the adapters — meaning the core packages are fully testable in any environment with a mock adapter, and adding a new runtime is just a new adapter package.

---

## Supported Runtimes

| Runtime | Surface | GPU Access | Notes |
|---|---|---|---|
| Web | `HTMLCanvasElement` | `navigator.gpu` | Full support |
| React Native | `SurfaceCapabilities` | `navigator.gpu` via `react-native-webgpu` | Full support |
| Node.js | None / `OffscreenCanvas` | `dawn-node` / `wgpu-native` | Headless; full tensor/NN support |

---

## Package Overview

```
Runtime Adapters (platform boundary)
  ├── @vgpu/adapter-web
  ├── @vgpu/adapter-react-native
  └── @vgpu/adapter-node

@vgpu/core                ← GPU primitives + event bus + plugin system
  ├── @vgpu/wgsl           ← WGSL+ module system, preprocessor, stdlib
  ├── @vgpu/render         ← Shader pipelines, fullscreen rendering, post-FX
  ├── @vgpu/scene          ← 3D scene graph, cameras, materials, lights
  ├── @vgpu/tensor         ← GPU tensors, compute kernels, autodiff
  ├── @vgpu/nn             ← LLM layers, attention, training, inference
  ├── @vgpu/math           ← Function plotters, vector fields, SDF viz
  └── @vgpu/react          ← React/RN bindings

Language Tooling
  ├── @vgpu/language        ← WGSL+ grammar, AST, parser, type checker
  ├── @vgpu/language-server ← LSP implementation
  └── @vgpu/vscode          ← VS Code extension (syntax highlighting + LSP)

Build Plugins
  ├── @vgpu/vite-plugin
  ├── @vgpu/metro-plugin
  └── @vgpu/esbuild-plugin
```

---

## Runtime Adapters

### The `VGPUAdapter` Interface

The only interface that differs per platform. `@vgpu/core` depends solely on this contract:

```typescript
interface VGPUAdapter {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter>
  createSurface(config: SurfaceConfig): VGPUSurface | null

  readonly platform: 'web' | 'react-native' | 'node'
  readonly supportsPresentation: boolean
  readonly preferredFormat: GPUTextureFormat

  onVisibilityChange?(handler: (visible: boolean) => void): () => void
  onResize?(surface: VGPUSurface, handler: (w: number, h: number) => void): () => void
}

interface VGPUSurface {
  getCurrentTexture(): GPUTexture
  present(): void
  configure(descriptor: GPUCanvasConfiguration): void
  readonly width: number
  readonly height: number
}
```

### `@vgpu/adapter-web`

- Uses `navigator.gpu` directly
- Surface wraps `HTMLCanvasElement` + `GPUCanvasContext`
- Resize via `ResizeObserver`
- `preferredFormat` from `navigator.gpu.getPreferredCanvasFormat()`

### `@vgpu/adapter-react-native`

- Uses `navigator.gpu` from `react-native-webgpu`
- Surface wraps RN's `SurfaceCapabilities` + `useWebGPUContext` hook
- Resize via RN layout events
- `preferredFormat` is `bgra8unorm` on iOS/Android
- Peer dep: `react-native-webgpu >= 0.4`

### `@vgpu/adapter-node`

- Uses `dawn-node` or `wgpu-native` bindings
- Surface is `null` unless a windowing lib is provided (e.g. `node-canvas`)
- Can accept an `OffscreenCanvas` or custom surface factory
- `preferredFormat` is `rgba8unorm` for headless output
- Peer dep: `dawn-node` (optional). Works fully headless for tensor/NN workloads.

### Auto-Detection

```typescript
import { createDevice } from '@vgpu/core'

const device = await createDevice()                           // auto (RN → web → node)
const device = await createDevice({ adapter: nodeAdapter })  // explicit override
```

---

## `@vgpu/core`

The only package every other depends on. Owns three responsibilities: **GPU context**, **the event bus**, and **the plugin system**.

### `VGPUDevice`

```typescript
VGPUDevice
  .create(options?: DeviceOptions): Promise<VGPUDevice>

  // GPU
  .device: GPUDevice
  .adapter: GPUAdapter
  .capabilities: { maxBindGroups, maxComputeWorkgroups, ... }

  // Runtime
  .platform: 'web' | 'react-native' | 'node'
  .isHeadless: boolean
  .supportsPresentation: boolean

  // Surfaces
  .createSurface(config): VGPUSurface | null
  .surfaces: Map<string, VGPUSurface>

  .destroy()
```

### Event Bus (`VGPUBus`)

Centralized, typed pub/sub. Every package emits and subscribes through this. No direct coupling between packages.

```typescript
VGPUBus
  .emit(event: VGPUEvent)
  .on(type, handler) → unsubscribe fn
  .once(type, handler)
  .off(type, handler)
  .pipe(bus: VGPUBus)
```

All events across all packages are collected into a single `VGPUEventMap` type via declaration merging:

```typescript
// @vgpu/render augments this
declare module '@vgpu/core' {
  interface VGPUEventMap {
    'render:frame-end': { deltaTime: number; frame: number }
  }
}
```

Core emits: `device:ready`, `device:lost`, `frame:begin`, `frame:end`, `resize`.

### Plugin System (`VGPUPlugin`)

```typescript
interface VGPUPlugin {
  name: string
  version: string
  dependencies?: string[]
  install(app: VGPUApp): void | Promise<void>
  dispose?(): void
}

VGPUApp
  .use(plugin: VGPUPlugin)
  .get<T>(token: symbol): T      // service locator for plugin-provided services
  .has(name: string): boolean
  .dispose()
```

```typescript
// User code
const app = new VGPUApp(device, bus)
app.use(RenderPlugin({ canvas }))
app.use(ScenePlugin())
app.use(TensorPlugin({ memoryBudget: '2GB' }))

const renderer = app.get(RenderPlugin.token)
const scene    = app.get(ScenePlugin.token)
```

### Core Primitives

Lightweight wrappers used by every package:

- **`Buffer`** — typed wrapper around `GPUBuffer` with staging, mapping, and ring-buffering helpers
- **`Shader`** — WGSL source + reflection (binding slots, entry points, workgroup size)
- **`Pipeline`** — cached render or compute pipeline with automatic invalidation
- **`BindGroup`** — declarative binding builder
- **`Encoder`** — fluent `GPUCommandEncoder` / `GPURenderPassEncoder` wrapper
- **`Clock`** — frame timing, delta time, elapsed time, fps

All primitives implement `Disposable` and emit a `dispose` event on destruction.

### Frame Loop Abstraction

Handles `requestAnimationFrame` differences across runtimes:

```typescript
interface VGPULoopDriver {
  start(callback: (time: number) => void): void
  stop(): void
  requestFrame(): void  // manual single frame; useful in headless Node
}
```

Implementations: `requestAnimationFrame` (web + RN), `setImmediate`-based loop (Node).

### Resource Registry

A `WeakRef`-based registry tracking all live GPU resources for cleanup on device loss or teardown. `VGPUApp.dispose()` cascades through all registered plugins and resources in reverse-install order.

### Serialization Hooks

Scenes, pipelines, and tensors support `toJSON()` / `fromJSON()` for checkpointing and state transfer.

---

## `@vgpu/wgsl`

The WGSL module system, preprocessor, and stdlib. Used by all other packages and by build tooling.

### WGSL+ Superset

Standard WGSL is valid WGSL+. Extensions:

```wgsl
// Import system
#import vgpu::math::sdf::sphere
#import vgpu::noise::simplex as simplex3
#import vgpu::lighting::pbr::{brdf, fresnel}
#import ./local-utils.wgsl

// Parameterized templates
#template MAX_LIGHTS = 4
#template WORKGROUP_SIZE = 64

// Conditional compilation
#if PLATFORM == "web"
  // web-specific code
#endif

// Annotations for pipeline binding reflection
@uniform(0, 0) var<uniform> params: Params;
@storage(0, 1) var<storage, read_write> output: array<f32>;
```

### Module Resolver

Resolves `#import` paths to source. Platform-aware via an injected `Resolver` interface:

```typescript
interface ModuleResolver {
  resolve(specifier: string, from: string): Promise<string | null>
}
```

Implementations: `FsResolver` (Node), `FetchResolver` (web), `VirtualResolver` (tests/LSP). The stdlib ships as a virtual module map — no filesystem access needed.

### WGSL Stdlib

```
math/      sdf, noise, hash, quaternion, complex, easing
lighting/  pbr, phong, ambient_occlusion, shadows
color/     conversions, oklch, tone_mapping
compute/   prefix_sum, radix_sort, histogram
nn/        softmax, gelu, rms_norm, attention
```

---

## `@vgpu/render`

Shader-first, 2D/fullscreen rendering. Minimal scene concept — just pipelines, passes, and drawing.

### Key Concepts

- **`RenderTarget`** — wraps a `GPUTexture` (or canvas context); supports MSAA, depth, custom formats
- **`Pass`** — a configured render pass with clear color, load ops, and stencil
- **`Material`** — a WGSL shader + uniform layout + pipeline state (blend mode, topology, etc.)
- **`Quad`** — fullscreen triangle mesh, the bread and butter for shader rendering
- **`Renderer`** — orchestrates passes and manages frame submission

### Render Loop

```typescript
renderer
  .beginFrame()
  .pass(myRenderTarget, pass => {
    pass.draw(quad, shaderMaterial)
    pass.draw(particles, particleMaterial)
  })
  .endFrame()
```

### Uniform System

Declarative, type-safe uniform block builder. Maps TS types to WGSL structs and handles alignment padding automatically:

```typescript
const uniforms = Uniforms.define({
  time:       'f32',
  resolution: 'vec2f',
  mouse:      'vec2f',
})
```

### Headless / Node Support

```typescript
renderer.readback(target?: RenderTarget): Promise<ImageData>
renderer.setOutputEncoder(encoder: ImageEncoder)  // PNG, EXR, etc.
```

### Events

`render:frame-begin`, `render:frame-end`, `render:pass-begin`, `render:pass-end`, `render:resize`

---

## `@vgpu/scene`

Traditional 3D scene graph on top of `@vgpu/render`.

### Scene Graph

- **`Node`** — base transform node (position, rotation, scale, parent/children, dirty-flag matrix propagation)
- **`Camera`** — perspective / orthographic, frustum culling support
- **`Mesh`** — Node + Geometry + Material
- **`Geometry`** — vertex buffers, index buffer, attribute layout, instancing support
- **`Light`** — directional, point, spot; stored in a GPU-side light buffer
- **`Scene`** — root node + render pipeline orchestration

### Material System

- **`BaseMaterial`** — wires up the pipeline
- **`PBRMaterial`** — albedo, roughness, metallic, normal map
- **`UnlitMaterial`**, **`WireframeMaterial`**, **`DepthMaterial`** — utilities
- Fully custom materials by extending `BaseMaterial`

### Render Graph (opt-in)

A DAG of render passes with automatic dependency resolution and resource aliasing. Texture outputs of one pass auto-wire as inputs to the next.

### Events

`scene:node-added`, `scene:node-removed`, `scene:before-render`, `scene:after-render`

---

## `@vgpu/tensor`

GPU-accelerated tensor operations via compute shaders. No rendering dependency. Works identically on all three platforms — Node is a first-class target for training workloads.

### Core Types

- **`Tensor`** — n-dimensional array backed by a `GPUBuffer`; dtype-aware (`f32`, `f16`, `i32`, `u32`)
- **`TensorView`** — non-owning slice/reshape, zero-copy
- **`Kernel`** — a compiled compute shader bound to specific input/output tensor shapes

### Operation System

Operations are lazy by default — they build a compute graph and flush when a value is awaited:

```typescript
const c = tensor.add(a, b).mul(scalar(2)).relu()
await c.read()  // schedules and runs all pending compute
```

Supported ops: elementwise math, reduction (sum, mean, max), matmul, conv2d, transpose, gather, scatter, softmax.

### Memory Management

- Tensor pool for buffer reuse
- Automatic staging buffer management for CPU↔GPU transfers
- Optional memory budget + eviction policy

### Events

`tensor:kernel-dispatch`, `tensor:oom`, `tensor:transfer`

---

## `@vgpu/nn`

Built on `@vgpu/tensor`. For training and running neural networks, specifically targeting LLM-class workloads.

### Layers

All layers are composable modules:

- `Linear`, `Embedding`, `LayerNorm`, `RMSNorm`
- `MultiHeadAttention` (grouped query attention support)
- `MLP`, `SwiGLU`, `GeLU`
- `CausalSelfAttention` with KV cache
- `TransformerBlock`, `Transformer`

### Autodiff

Reverse-mode autograd engine that traces operations through the tensor graph and computes gradients via compute shaders. Gradients are themselves tensors — no CPU round-trips.

### Training

- **`Optimizer`** — SGD, AdamW, Lion; GPU-side parameter updates
- **`LRScheduler`** — cosine, warmup, step
- **`Trainer`** — batching, gradient accumulation, mixed precision (f16/f32), checkpoint hooks

### Inference

- **`Sampler`** — top-k, top-p, temperature, greedy
- **`KVCache`** — pre-allocated, managed across decode steps
- **`GenerationLoop`** — token streaming, stop conditions, max length

### Events

`nn:step-begin`, `nn:step-end`, `nn:loss`, `nn:gradient-norm`, `nn:generate-token`

---

## `@vgpu/math`

Visualization toolkit for math concepts. Depends on `@vgpu/render` or `@vgpu/scene`. Supports headless render mode that returns pixel buffers for server-side visualization.

### Primitives

- **`Axes`** — 2D/3D axis lines with labels
- **`Grid`** — configurable grid mesh
- **`FunctionPlotter`** — plots `f(x)`, `f(x,y)`, parametric curves and surfaces; GPU-evaluated via compute
- **`VectorField`** — renders 2D/3D vector fields as instanced arrows
- **`SDFRenderer`** — renders signed distance fields with ray marching
- **`ComplexPlane`** — visualizes complex functions with domain coloring

### Coordinate Space

A `CoordinateSpace` abstraction handles mapping between math space and screen/NDC space. All math objects support animated parameters — pass a `(t: number) => value` anywhere a static value is accepted.

### Events

`math:plot-update`, `math:camera-change`

---

## `@vgpu/react`

Reactive bindings for web and React Native. Ships as two sub-targets resolved at bundle time:

- `@vgpu/react/web` — DOM-based hooks and components
- `@vgpu/react/native` — RN-specific hooks and `<VGPUView>` component

Shared hooks work on both: `useVGPUDevice`, `useTensor`, `useScene`, `useRenderer`.

---

## Language Tooling

### `@vgpu/language`

The foundation for all tooling. Zero runtime deps. Works in Node, browser, and workers.

A hand-written recursive descent parser producing:

```typescript
interface WGSLPlusDocument {
  uri:         string
  source:      string
  ast:         ProgramNode
  imports:     ImportNode[]
  templates:   TemplateNode[]
  diagnostics: Diagnostic[]
  tokens:      Token[]           // for syntax highlighting
}
```

The **type checker** validates:

- WGSL built-in types and custom struct types (including cross-file from imports)
- Built-in function overload resolution
- Binding group/slot conflicts across the entire pipeline
- Template parameter usage
- vgpu stdlib symbol existence

The **scope & symbol table** answers cross-file queries: "What type at position X?", "Where is this declared?", "All symbols in scope at X?", "All references to this symbol?" — powering every editor feature downstream.

---

### `@vgpu/language-server`

A full LSP server. Runs as a separate Node process (VS Code model) or as an in-process library for embedding in other editors.

**Diagnostics** — parse errors, type errors, import errors, binding conflicts, deprecation warnings.

**Hover** — full type signature, doc comments, stdlib docs with online reference links.

**Completion** — context-aware suggestions:

- After `#import vgpu::` — fuzzy-matched stdlib module tree
- Inside function bodies — all in-scope variables, functions, built-ins
- After struct identifier `.` — struct fields with types
- After `@` — valid WGSL + vgpu attributes
- After `var<` — storage classes
- Inside constructors — expected component types

**Signature Help** — parameter hints as you type, with current parameter highlighted.

**Go to Definition** — navigates to declarations in the same file, imported files, or read-only virtual stdlib documents.

**Find All References** — lists every use of a symbol across the workspace.

**Rename Symbol** — renames across all files simultaneously.

**Code Actions** — "Add missing import", "Remove unused import", "Convert to template parameter", "Sort imports", "Inline constant".

**Inlay Hints** — optional ghost text for type annotations, return types, parameter names at call sites.

**Document / Workspace Symbols** — outline panel and cross-file symbol search.

**Formatting** — opinionated formatter (consistent indentation, aligned struct fields, import sorting). Configurable via `.vgpu.json`.

**Semantic Tokens** — distinguishes struct type names vs variable names, built-in vs user-defined functions, uniform vs storage vs local variables, template parameters.

---

### `@vgpu/vscode`

The VS Code extension shipping the LSP + extra editor integrations.

**TextMate Grammar** — instant syntax highlighting before LSP starts, covering:

- WGSL keywords, types, built-in functions
- vgpu directives (`#import`, `#template`, `#if`)
- Attributes, numeric literals, comments

**Shader Preview Panel** — a live-rendering webview:

- Renders the active fragment shader on a fullscreen quad
- Hot-reloads on save
- Auto-connected `time` and `resolution` uniforms
- Configurable custom uniforms via JSON sidebar

**Pipeline Inspector** — tree view showing inferred pipeline layout from the open shader: bind groups, binding slots, vertex attributes, workgroup size.

**WGSL Stdlib Browser** — sidebar panel with live search, rendered docs, and click-to-insert.

**Shader Diff** — semantic diff between two shaders (understands renamed variables, reordered bindings).

**Configuration (`.vgpu.json`)**:

```json
{
  "wgsl": {
    "strictMode": true,
    "treatWarningsAsErrors": false,
    "importAliases": { "~shaders": "./src/shaders" }
  },
  "formatter": {
    "indentWidth": 2,
    "maxLineLength": 100,
    "sortImports": true
  },
  "preview": {
    "autoReload": true,
    "defaultResolution": [800, 600]
  }
}
```

---

## Build Plugins

All three share a common transform pipeline from `@vgpu/language`:

```
Source (.wgsl or template literal)
  → Parse (WGSLPlusDocument)
  → Resolve imports (inline stdlib)
  → Validate (type check, binding conflicts)
  → Apply templates
  → Strip vgpu directives
  → Emit standard WGSL string
  → (optional) Emit binding reflection JSON
```

### Binding Reflection

At build time, plugins emit a typed reflection object alongside each shader — bind group creation in TypeScript is type-checked against the actual shader:

```typescript
// Auto-generated at build time
export const MyShaderBindings = {
  groups: {
    0: {
      0: { name: 'params', type: 'uniform', wgslType: 'Params' },
      1: { name: 'output', type: 'storage', access: 'read_write', wgslType: 'array<f32>' }
    }
  },
  workgroupSize: [64, 1, 1],
  stages: ['compute']
} as const satisfies VGPUReflection
```

### `@vgpu/vite-plugin`

Supports HMR — changing a `.wgsl` file hot-reloads only the affected pipeline without a full page reload.

### `@vgpu/metro-plugin`

Same transform pipeline, outputs CommonJS compatible with Metro's module system.

### `@vgpu/esbuild-plugin`

For Node.js server builds and CLIs.

### Package Exports (each package)

```json
{
  "exports": {
    ".": {
      "react-native": "./dist/index.rn.js",
      "node": "./dist/index.node.js",
      "default": "./dist/index.web.js"
    }
  }
}
```

---

## Repository Structure

```
packages/
  core/           @vgpu/core
  wgsl/           @vgpu/wgsl
  render/         @vgpu/render
  scene/          @vgpu/scene
  tensor/         @vgpu/tensor
  nn/             @vgpu/nn
  math/           @vgpu/math
  react/          @vgpu/react
  adapter-web/    @vgpu/adapter-web
  adapter-rn/     @vgpu/adapter-react-native
  adapter-node/   @vgpu/adapter-node

tooling/
  language/         @vgpu/language
  language-server/  @vgpu/language-server
  vscode/           @vgpu/vscode
  vite-plugin/      @vgpu/vite-plugin
  metro-plugin/     @vgpu/metro-plugin
  esbuild-plugin/   @vgpu/esbuild-plugin

examples/
  shader-toy/
  basic-3d/
  llm-inference/
  function-plot/
  rn-scene/

docs/
```

Monorepo via pnpm workspaces + Turborepo. Each package compiles to ESM + CJS with `.d.ts`. Tests via Vitest with a headless WebGPU adapter.

---

## Implementation Order

| Phase | Packages | Goal |
|---|---|---|
| 1 | `@vgpu/adapter-web`, `@vgpu/adapter-node` | Validate both runtimes before building anything on top |
| 2 | `@vgpu/core` | Device, bus, plugin system, frame loop, primitives |
| 3 | `@vgpu/wgsl` | Module system (needed by everything) |
| 4 | `@vgpu/language` (parser only) | Foundation for build tooling and LSP |
| 5 | `@vgpu/vite-plugin` | End-to-end build validation; enables examples |
| 6 | `@vgpu/tensor` | Compute-only; fully validates Node path |
| 7 | `@vgpu/render` | Validates web + Node headless paths |
| 8 | `@vgpu/adapter-react-native` | Add RN once web/node are stable |
| 9 | `@vgpu/scene`, `@vgpu/nn`, `@vgpu/math` | Capability packages |
| 10 | `@vgpu/language` (type checker + LSP) | Full language server |
| 11 | `@vgpu/vscode` | Extension: grammar → LSP → preview panel |
| 12 | `@vgpu/react`, `@vgpu/metro-plugin`, `@vgpu/esbuild-plugin` | Reactive bindings and remaining build plugins |

---

## Key Architectural Bets

**Adapter pattern isolates runtimes.** Adding Deno, Bun, or a native desktop shell is a new adapter package — nothing else changes.

**`@vgpu/language` is standalone.** The parser runs in the LSP server (Node), build plugins (bundle time), VS Code preview (webworker), and tests (anywhere). One parser, same diagnostics everywhere.

**Binding reflection closes the loop.** Build-time reflection means the TypeScript API and the WGSL shader are always in sync — no runtime binding mismatches, no manual type duplication.

**The event bus is the nervous system.** Packages communicate through typed events without importing each other, keeping the dependency graph acyclic and the packages individually publishable.
