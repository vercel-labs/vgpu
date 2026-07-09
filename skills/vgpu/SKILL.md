---
name: vgpu
description: >-
  Build and optimize WebGPU shaders and render pipelines with vgpu (@vgpu/core, @vgpu/render,
  @vgpu/wgsl). Use when authoring GPU rendering or making it faster. Bundles the performance
  guides and the full API reference; load one doc at a time.
---

# vgpu

Generated from the vgpu `.docs.md` source. Each entry maps to a file in `references/` and to a
doc you can load on demand with the CLI — **load only what you need, don't read the whole skill**:

```sh
npx vgpu docs find <query>    # search doc paths + symbols
npx vgpu docs grep -i <term>  # search doc CONTENT
npx vgpu docs cat <symbol>    # print one doc, e.g. `cat Frame`, `cat performance-model`
```

## Performance guides

Writing or optimizing a shader? Read **performance-model** first, then the rest as needed.

- **authoring-for-perf** — Tier-0 habits: how to write a shader during iteration so the later optimize pass is mechanical instead of archaeological.  `references/guides/authoring-for-perf.docs.md`
- **browser-testing** — Reliable Playwright WebGPU runs in VGPU rely on the SwiftShader Vulkan stack inside a virtual X11 server.  `references/guides/browser-testing.docs.md`
- **getting-started** — Use this as the VGPU docs index when you arrive through npx vgpu docs.  `references/guides/getting-started.docs.md`
- **measuring** — How to verify a shader optimization before keeping it: confirm it's still correct (pixelDiff) and actually faster (gpuFrameTime).  `references/guides/measuring.docs.md`
- **optimize-pass** — A procedure to run once the look is locked, to clean up and speed up shader/render code without changing what's on screen.  `references/guides/optimize-pass.docs.md`
- **performance-model** — The mental model for making vgpu render code fast.  `references/guides/performance-model.docs.md`
- **performance-patterns** — The catalog of vgpu render optimizations, ordered by typical payoff.  `references/guides/performance-patterns.docs.md`

## API reference

110 symbols across 12 packages — open `references/<package>/<file>` or `npx vgpu docs cat <symbol>`:

- `@vgpu/adapter-mock` — createMockAdapter
- `@vgpu/adapter-node` — createNodeAdapter, createNodeDevice
- `@vgpu/core` — App, AppCreateOptions, AppInstance, bind, BindVisibility, Buffer, BufferOptions, BufferPingPong, BufferUsageName, BufferWriteData, createBindGroup, createBindGroupLayout, CreateBindGroupLayoutOptions, CreateBindGroupOptions, CreateDeviceOptions, createMockGPUDevice, createPipelineLayout, CreatePipelineLayoutOptions, createSampler, Device, DeviceLike, pingPong, PingPongCore, Queue, SamplerDescriptorWithSugar, Shader, ShaderInput, Texture, TextureOptions, TexturePingPong, TextureUsageName, ValidationError, VGPUAdapter, VGPUError
- `@vgpu/render` — beginFrame, Camera, ColorAttachment, createRenderBundle, createRenderPipeline, createRenderPipelineFromDescriptor, createRenderPipelineFromDescriptorAsync, degToRad, DepthStencilAttachment, DrawSpec, Frame, FrameOptions, FrameRenderPassCallback, Mat4, Material, MaterialUniformValue, Mesh, orthographicCamera, perspectiveCamera, RapidRenderer, RenderBundleOptions, RenderBundleRecorder, RenderPass, RenderPassDrawOptions, RenderPassDynamicOffsets, RenderPassOptions, RenderPipelineOptions, srgb, StorageBuffer, StorageBufferOptions, Uniform, UniformLayout, UniformOptions, UniformPool, UniformPoolOptions, UniformSlot, Vec3
- `@vgpu/render/inspect` — InspectMaterial, InspectMaterialUniformParams, meshToWireframe, normalDebugMaterial, NormalDebugMaterialSpec, wireframeMaterial, WireframeMaterialSpec, WireframeMesh
- `@vgpu/render/passes` — renderTargetForCanvas
- `@vgpu/render/perf` — gpuFrameTime, GpuFrameTimeOptions, GpuFrameTimeResult, pixelDiff, PixelDiffResult
- `@vgpu/render/utils` — canvasMouseTracker, CanvasMouseTracker, CanvasMouseTrackerSpec, canvasResolution, CanvasResolution, frameClock, FrameClock
- `@vgpu/wgsl` — compile, ResolvedShader, SourceMap, WGSLAst, WGSLSource
- `@vgpu/wgsl/loader-vite` — transformWgsl, ViteLoadResult, wgslVitePlugin
- `@vgpu/wgsl/loader-webpack` — wgslWebpackLoader
- `@vgpu/wgsl/runtime` — ResolvedShader, ResolveOptions, resolveShader, SourceMap, WGSLAst, WGSLModule
