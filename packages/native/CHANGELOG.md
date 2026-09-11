# @vgpu/native

## 0.5.0-rc.1

### Minor Changes

- Publish the optional `@vgpu/native` companion as a beta for generating self-contained
  Swift/Metal shader packages through `vgpu native doctor`, `check`, `build`, and `verify`.
  Bundle the pinned, hash-authenticated Tint worker, compiler schemas, C helpers and
  third-party license notices. Installation does not compile or download Tint.
  Expose only the internal `@vgpu/native/cli` protocol consumed by the vgpu CLI; the
  low-level TypeScript generator is not a supported public API.

  [Migration guide](https://github.com/vercel-labs/vgpu/blob/v0.5.0-rc.1/docs/migrations/0.5.0.docs.md).

### Patch Changes

- Updated dependencies [632a908]
  - @vgpu/wgsl@0.5.0-rc.1
