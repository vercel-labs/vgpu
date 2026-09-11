---
"@vgpu/native": minor
"vgpu": patch
---

## Summary

Publish the optional `@vgpu/native` companion as a beta for generating self-contained
Swift/Metal shader packages through `vgpu native doctor`, `check`, `build`, and `verify`.
Bundle the pinned, hash-authenticated Tint worker, compiler schemas, C helpers and
third-party license notices. Installation does not compile or download Tint.
Expose only the internal `@vgpu/native/cli` protocol consumed by the vgpu CLI; the
low-level TypeScript generator is not a supported public API.

## Migration

### Affected usage

Opt-in native tooling users and users of the empty `@vgpu/native@0.0.1` bootstrap.
Existing browser/WebGPU consumers do not need to install the companion. The bootstrap
contains no operational API or generated outputs to migrate.

### Steps

Install `vgpu` and `@vgpu/native` as development dependencies at the same exact RC
version, using `--save-exact`; do not rely on the bootstrap package or mix release
versions. Use the `vgpu native` commands, not direct generator imports. Prepare an
Apple Silicon build host with Node.js 22 and Xcode with its Metal compiler component.
Create `vgpu.native.json` following the native configuration guide.

This beta's worker is ad hoc signed, not Developer ID signed or notarized. Verify
execution in your own development/CI environment without disabling system security
protections. APIs, generated Swift interfaces, configuration and toolchain requirements
may change during beta. Pin versions and review each upgrade. Universal worker slices
do not imply qualified Intel GPU or minimum-macOS support.

The consuming app owns its Metal resources and receives only generated Swift and
compiled Metal resources; Node, Tint and Xcode remain build-time requirements.

### Verification

In a project outside the vgpu checkout, run `vgpu native doctor`, `check`, `build`,
and `verify`. Build and execute a Swift consumer using the generated package and
check the intended render/compute results on the target GPU. Confirm the app bundle
does not contain the compiler worker or a JavaScript runtime introduced by this tooling.
