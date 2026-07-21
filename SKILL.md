---
name: vgpu
description: >-
  Build and optimize WebGPU apps with the vgpu package and entrypoints vgpu/node,
  vgpu/mock, vgpu/scene, and vgpu/client. Use @vgpu/render/inspect, /utils, /edit,
  and /perf only as slim tooling subpaths. Bundles performance guides and the API
  reference; load one doc at a time.
---

# vgpu

Generated from the vgpu `.docs.md` source. Each entry maps to a file in `references/` and to a
doc you can load on demand with the CLI — **load only what you need, don't read the whole skill**:

vgpu is layered: vgpu/core (thin WebGPU wrappers) → vgpu (main API with WGSL reflection) → vgpu/scene (geometry/camera helpers). Lower layers are always accessible and interoperable.

Glossary: **Surface** means a canvas-backed render target (swapchain) created with `gpu.surface(canvas)`; do not confuse it with the general phrase ‘API surface’.

```sh
npx --package @vgpu/cli vgpu docs find <query>    # search doc paths + symbols
npx --package @vgpu/cli vgpu docs grep -i <term>  # search doc CONTENT
npx --package @vgpu/cli vgpu docs cat <symbol>    # print one doc, e.g. `cat Frame`, `cat performance-model`
```

Docs app workflows live in `apps/docs/README.md`. Use it when you need to re-bake example thumbnails with `pnpm thumbs:docker` / `pnpm --filter docs thumbs:check` (pass `-- --only <slug>` for a single example).

## Performance guides

Writing or optimizing a shader? Read **performance-model** first, then the rest as needed.

- **authoring-for-perf** — Write WGSL so reflection can build stable layouts.  `references/guides/authoring-for-perf.docs.md`
- **browser-testing** — Browser tests should exercise the same public API users copy: init(), gpu.surface(canvas, opts), explicit targets, and deterministic frame submission.  `references/guides/browser-testing.docs.md`
- **getting-started** — Start with the public vgpu package.  `references/guides/getting-started.docs.md`
- **measuring** — Measure the thing you intend to optimize: CPU encoding, pipeline warm-up, bind-group churn, target memory, or shader cost.  `references/guides/measuring.docs.md`
- **optimize-pass** — Optimize one pass by first deciding what changes every frame.  `references/guides/optimize-pass.docs.md`
- **performance-model** — vgpu's public API is organized around stable identities.  `references/guides/performance-model.docs.md`
- **performance-patterns** — This is the quick index.  `references/guides/performance-patterns.docs.md`
- **performance-playbook** — This guide is for LLMs and humans writing shaders.  `references/guides/performance-playbook.docs.md`
- **shader-fix-its** — Use these messages as the self-correction map for generated shader code.  `references/guides/shader-fix-its.docs.md`

## API reference

196 symbols across 15 packages — open `references/<package>/<file>` or `npx --package @vgpu/cli vgpu docs cat <symbol>`:

- `@vgpu/render/edit` — bevel, bridge, dissolveEdges, dissolveFaces, dissolveVertices, EdgeView, EditableMesh, EditableMeshValue, ElementDomain, ElementSelection, ElementSet, extrude, FaceView, fillHole, gridFill, healManifold, inset, KernelHandle, loopCut, mergeByDistance, MeshEditError, MeshEditWarning, recomputeNormals, ScoredSelection, subdivideEdges, subdivideFaces, toEditable, toEditableWithDiagnostics, VertexView
- `@vgpu/render/inspect` — InspectMaterial, InspectMaterialUniformParams, meshToReadable, meshToWireframe, normalDebugMaterial, NormalDebugMaterialSpec, wireframeMaterial, WireframeMaterialSpec, WireframeMesh
- `@vgpu/render/perf` — gpuFrameTime, GpuFrameTimeOptions, GpuFrameTimeResult, pixelDiff, PixelDiffResult
- `@vgpu/render/utils` — canvasMouseTracker, CanvasMouseTracker, CanvasMouseTrackerSpec, canvasResolution, CanvasResolution, frameClock, FrameClock
- `@vgpu/wgsl` — compile, ResolvedShader, SourceMap, WGSLAst, WGSLSource
- `@vgpu/wgsl-std/color` — applyExposure, luminance, luminanceThreshold, tonemapAces, tonemapReinhard
- `@vgpu/wgsl-std/fullscreen` — fullscreenTriangleClip, fullscreenTriangleUv
- `@vgpu/wgsl-std/hash` — hash1, hash2, hash3, hashU32, pcg2d, pcg3d, unitFloat
- `@vgpu/wgsl-std/noise` — voronoi2d, voronoi3d, VoronoiSample2, VoronoiSample3
- `@vgpu/wgsl/loader-vite` — transformWgsl, ViteLoadResult, wgslVitePlugin
- `@vgpu/wgsl/loader-webpack` — wgslWebpackLoader
- `@vgpu/wgsl/runtime` — ResolvedShader, ResolveOptions, resolveShader, SourceMap, WGSLAst, WGSLModule
- `vgpu` — Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Draw, DrawCallOptions, DrawLayoutOptions, DrawOptions, Effect, EffectOptions, Frame, FrameLoopHandle, FramePass, FramePassOptions, FrameRunner, Gpu, init, InitOptions, MeshLike, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, Surface, SurfaceOptions, SurfaceResizeEvent, Target, TargetOptions, TargetTextureOptions, Uniform, UniformOptions
- `vgpu/core` — bind, Buffer, BufferOptions, createBindGroup, createBindGroupLayout, CreateDeviceOptions, createPipelineLayout, createRenderBundle, createSampler, Device, DeviceOptions, Queue, RenderBundleOptions, RenderBundleRecorder, ScalarUniformType, StorageBuffer, StorageBufferOptions, StructuredUniform, StructuredUniformOptions, Texture, TextureOptions, Uniform, UniformField, UniformLayout, UniformLayoutInfo, UniformOptions, UniformPool, UniformPoolOptions, UniformSlot, UniformValues, ValidationError, VectorUniformInput, VGPUAdapter, VGPUError, WgslUniformType
- `vgpu/scene` — box, BoxOptions, Camera, CameraVec3, capsule, CapsuleOptions, cone, ConeOptions, cylinder, CylinderOptions, degToRad, disk, DiskOptions, dodecahedron, fullscreenQuad, FullscreenQuadOptions, geometries, GeometryKind, icosahedron, icosphere, IcosphereOptions, Mat4, octahedron, orbit, OrbitOptions, orthographicCamera, OrthographicCameraOptions, perspectiveCamera, PerspectiveCameraOptions, plane, PlaneOptions, PolyhedronOptions, ring, RingOptions, SceneCamera, SceneGeometry, SceneGeometryOfKind, SceneMesh, sphere, SphereOptions, srgb, tetrahedron, torus, TorusOptions, Vec3
