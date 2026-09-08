# @vgpu/native

Private build-time tooling for generated Metal integration. This package is not published and does
not implement a Swift renderer or a public `vgpu native` command.

`generateMetalPackage` accepts compiled library bytes and selected emitted function names. It
returns the files of a self-contained Swift package without writing to disk. WGSL resolution,
translation, offline compilation, atomic output publication, uniform packing, and resource binding
are separate integration work; this generator does not establish those contracts.

The generated consumer API is documented in
[Load Metal functions](../../docs/topics/native/macos/metal/native-macos-metal-functions.docs.md).
Keep that guide, the generated Swift, and the external consumer fixtures aligned when changing it.

## Checks

From the repository root:

```sh
pnpm --dir packages/native build
pnpm --dir packages/native test
pnpm --dir packages/native test:native
```

The portable suite checks generation and input validation. The separate native suite targets
Apple silicon and requires a Metal device, Swift tooling, and Xcode's Metal compiler component.
Missing tool or device prerequisites fail the native suite; passing the portable suite does not
imply native coverage. The suite does not enforce an architecture gate or establish Intel support.

Native fixtures compile small handwritten Metal shaders to isolate packaging and loading, then
build and execute external Swift consumers, including the guide's Swift snippets. They do not
prove the complete WGSL-to-Metal build pipeline or a release support matrix. Temporary consumers
and resources are created outside the repository and cleaned up by the test harness.
