# Plan: native Swift API over Metal

Status: docs-first API validation. No public package or command described here exists yet.

## Outcome

Bring the vgpu programming model to Swift while using Metal directly at runtime. A developer who
already knows `Gpu`, `Surface`, `Target`, `Effect`, `Draw`, `Compute`, `Frame`, and `FramePass`
should recognize the same ownership and rendering model in Swift.

The goal is behavioral parity, not line-for-line syntax parity:

- WGSL remains the authored shader language.
- Node.js resolves, reflects, translates, and packages shaders at build time.
- The application ships a `.metallib`, generated Swift program types, and only the vgpu Swift
  products it selects. Source imports remain explicit at the module level.
- The Swift runtime products implement the public primitives over Metal without a JavaScript
  runtime or shader translator in the application.
- Generated shader types describe programs. They do not own views, frame loops, or renderers.
- Swift composes resources and frames dynamically. A future TypeScript graph compiler is an
  optional frontend to the same artifact contract, not a prerequisite for the Swift runtime.

The first alpha is supported and tested on Apple silicon running macOS 14 or later, with the
application and Swift runtime executing natively as `arm64`. Intel-based Macs and their Intel or
AMD GPUs remain unverified and unsupported until the same runtime gates can run repeatedly on
physical hardware. This is a release-support boundary, not an API or artifact capability tier.

```text
WGSL modules
  -> vgpu resolver and reflection
  -> WGSL-to-MSL translation
  -> Apple Metal compiler
  -> versioned program manifest + .metallib + generated Swift
  -> selected vgpu Swift runtime products
  -> Metal
```

## Plan documents

- [Architecture](./architecture.md) defines module ownership, backend seams, surface adaptation,
  interop, and code-size boundaries.
- [API contract](./api-contract.md) records the JavaScript-to-Swift mapping, deliberate Swift
  differences, and the artifact information the generated ABI needs.
- [Rollout](./rollout.md) contains falsifiable gates, spike order, and the documentation gate.
- [Decisions](./decisions.md) separates accepted contracts from questions that still require a
  spike or product decision.

## Compiler contracts

The build manifest uses a generic envelope with one backend-neutral semantic contract and one
selected Metal projection. The compare protocol is Metal-specific and remains outside runtime
compatibility:

- [Artifact envelope](./contracts/artifact-v1.schema.json)
- [Semantic contract](./contracts/semantic-v1.schema.json)
- [Metal projection](./contracts/metal-projection-v1.schema.json)
- [Metal runner request](./contracts/metal-runner-request-v1.schema.json)
- [Metal runner response](./contracts/metal-runner-response-v1.schema.json)
