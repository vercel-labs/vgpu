---
title: "Render computed data"
description: "Write a native buffer with a WGSL compute shader, then read it from a render shader in the same Metal command buffer."
---

A generated binding accepts an ordinary Metal buffer. The same allocation can be written by one
shader and consumed by another without reading it back to the CPU between passes.

> Warning: Native tests on Apple silicon execute this example and verify every target pixel. They
> also compose application-owned blits before and after the passes. This is a bounded integration
> test, not a device support matrix. The generated package and native commands are not published yet.

## Share the shader layout

Both programs import this small type:

```wgsl
// shaders/color.wgsl
export struct Color {
  rgba: vec4<f32>,
}
```

The compute program writes it as storage:

```wgsl
// shaders/fill.wgsl
import { Color } from "./color.wgsl";

@group(0) @binding(0) var<storage, read_write> color: Color;

@compute @workgroup_size(1)
fn fill_main() {
  color.rgba = vec4<f32>(0.25, 0.5, 0.75, 1.0);
}
```

The render program reads it as a uniform:

```wgsl
// shaders/display.wgsl
import { Color } from "./color.wgsl";

@group(0) @binding(0) var<uniform> color: Color;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn fragment_main() -> @location(0) vec4<f32> {
  return color.rgba;
}
```

This `Color` has the same sixteen-byte layout in both address spaces. Do not assume that arbitrary
storage and uniform layouts are interchangeable. The compiler checks each program's supported
layout; the application decides whether sharing a resource is valid.

Configure `FrameShaders` with a `Fill` compute program selecting `fill_main` from
`shaders/fill.wgsl`, and a `Display` render program selecting `vertex_main` and `fragment_main`
from `shaders/display.wgsl`. See [Configure a Metal package](/native/macos/metal/tooling/configuration).

## Allocate one private buffer

Use your application's device, queue, and an `rgba32Float` render-target texture named `target`:

```swift
import Metal
import FrameShaders

let fill = try Fill.load(device: device)
let display = try Display.load(device: device)
let byteCount = Display.Uniforms.color.byteCount
let colorBuffer = device.makeBuffer(
  length: byteCount,
  options: [.storageModePrivate, .hazardTrackingModeTracked]
)!
let range = ShaderBufferRange(buffer: colorBuffer, offset: 0, length: byteCount)
let fillBindings = Fill.Bindings(color: range)
let displayBindings = Display.Bindings(color: range)
```

The example assumes allocations succeed. Private storage has no CPU packing step here: the compute
shader writes all sixteen bytes. Offset `0` satisfies both programs' binding alignment.

Create the application-owned pipelines:

```swift
let fillPipeline = try device.makeComputePipelineState(function: fill.compute)
let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = display.vertex
descriptor.fragmentFunction = display.fragment
descriptor.colorAttachments[0].pixelFormat = target.pixelFormat
let displayPipeline = try device.makeRenderPipelineState(descriptor: descriptor)
```

## Encode the producer before the consumer

Use ordinary Metal encoders on one command buffer:

```swift
let commandBuffer = queue.makeCommandBuffer()!
let compute = commandBuffer.makeComputeCommandEncoder()!
compute.setComputePipelineState(fillPipeline)
try fill.bind(fillBindings, to: compute)
compute.dispatchThreadgroups(
  MTLSize(width: 1, height: 1, depth: 1),
  threadsPerThreadgroup: Fill.workgroupSize
)
compute.endEncoding()

let pass = MTLRenderPassDescriptor()
pass.colorAttachments[0].texture = target
pass.colorAttachments[0].loadAction = .clear
pass.colorAttachments[0].storeAction = .store
pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
let render = commandBuffer.makeRenderCommandEncoder(descriptor: pass)!
render.setRenderPipelineState(displayPipeline)
try display.bind(displayBindings, to: render)
render.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
render.endEncoding()

withExtendedLifetime((colorBuffer, target, fillPipeline, displayPipeline)) {
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
}
precondition(commandBuffer.status == .completed, String(describing: commandBuffer.error))
```

With a tracked resource and an ordinary `MTLCommandQueue`, Metal handles the buffer hazard between
these ordered passes. This is not a guarantee for untracked heaps, concurrent encoders, another
queue, or Metal 4 command submission. Those need their own synchronization. See Apple's
[resource synchronization guide](https://developer.apple.com/documentation/metal/resource-synchronization).

Every target pixel should contain `(0.25, 0.5, 0.75, 1.0)` after completion. The only wait above is
after both passes; there is no intermediate CPU readback or second submission. A frame loop can
retain resources until a completion callback instead of waiting synchronously.

The generated helpers bind each program's recorded slots. They do not create a render graph,
schedule passes, choose storage modes, or insert application synchronization. Continue using
native Metal for those responsibilities.
