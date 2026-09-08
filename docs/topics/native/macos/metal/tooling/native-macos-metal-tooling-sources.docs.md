---
title: Resolve shader inputs
summary: Capture configured WGSL programs and their imports once, then validate and compile the same source graph.
websitePath: /native/macos/metal/tooling/sources
keywords: native, macos, metal, wgsl, imports, source graph, snapshot, verification
---

# Resolve shader inputs

A native build uses the configured entry shaders and every module they import. Capturing that
graph keeps the source bytes and import choices together: checking one set of files and compiling
a later reread would not validate the same input.

> Warning: This is the docs-first source-capture contract. The filesystem snapshot helpers and
> their native command integration are not implemented or published yet. The existing internal
> compiler accepts an explicit in-memory module map.

## Keep imports in WGSL

Use the same relative and installed-package imports as the TypeScript tooling:

```wgsl
// shaders/count.wgsl
import { width } from "./dimensions.wgsl";

@group(0) @binding(0) var<storage, read_write> output: array<u32, 2>;

@compute @workgroup_size(width)
fn count_main(@builtin(local_invocation_index) index: u32) {
  output[index] = 100u + index;
}
```

```wgsl
// shaders/dimensions.wgsl
export const width: u32 = 2u;
```

Relative imports resolve from their importing module. The `@/` alias resolves from the
configuration directory. Installed-package imports use vgpu's existing package resolution and
export rules; configuration does not replace them with another package map. Imported modules
remain pure: declare resources and entry points in entry shaders.

The graph includes imported modules even when a declaration is later removed as unused. A source
change can therefore make verification stale without changing the emitted shader.

## Capture the source graph

The command performs this step for you. Build-tool integrations can use the proposed WGSL helpers
directly, without importing the Metal compiler:

```ts
import { resolve } from "node:path";
import { captureShaderGraph, resolveShaderSnapshot } from "@vgpu/wgsl/runtime";

const rootDir = resolve(".");
const snapshot = await captureShaderGraph({
  rootDir,
  entries: { Count: resolve(rootDir, "shaders/count.wgsl") },
});

const shader = await resolveShaderSnapshot(snapshot, {
  entry: snapshot.entries.Count,
  validate: false,
  minify: false,
});
```

`entries` maps stable caller keys to absolute entry-file paths. `rootDir` is an absolute directory
for root-relative imports. Capture accepts an optional `AbortSignal` as `signal` and an optional
`onDependency(path)` callback for discovered imported files; the callback does not report entries
or promise that a discovered module loaded successfully.

Capture returns a `ShaderGraphSnapshot` with `schemaVersion: 1` and three fields:

- `entries` maps caller keys to opaque virtual module IDs.
- `modules` maps each ID to its original `source` text and an `imports` map from authored specifier
  to target ID. Different importer contexts keep their own resolved edges.
- `inputs` records each module's ID, `physicalPath`, and source `sha256` for input checks and diagnostics.

The snapshot owns its captured values. IDs follow sorted entry keys and authored import order;
do not construct or interpret them in application code. Physical paths do not belong in the
logical shader fingerprint. Moving an otherwise identical project does not change its logical
graph merely because its absolute checkout path changed.

Snapshots are versioned data, not handles tied to the process that captured them. A JSON round
trip or `structuredClone` can be replayed. Replay validates the snapshot's shape, source hashes,
and complete import edges before using it; malformed or unsupported snapshots fail without falling
back to the filesystem. Hash validation checks consistency, not who authored the source.

`resolveShaderSnapshot` uses only captured source and edges. It performs ordinary import, purity,
emission, and reflection checks without reading files or resolving packages again. Its `validate`
and `minify` options have the same meaning as `resolveShader`; native tooling disables WebGPU
validation and minification before running the pinned Metal compiler boundary. Capture itself
does not validate WGSL semantics or prove that a shader belongs to the supported Metal profile.

## Bound input reads

Source files must be regular, valid UTF-8 files without NUL bytes. The initial capture limits are
four MiB per source module, thirty-two MiB of captured module bytes, 1,024 graph modules, and 128
modules along an import chain. Package manifests used for resolution must be regular UTF-8 JSON
files no larger than one MiB. Exceeding a limit fails the capture; it does not truncate source or
return a partial graph. These limits are not command-line tuning flags.

Capturing is not an atomic snapshot of the entire filesystem. Finish edits and dependency
installation before running a native command. Capture reads each resolved module once per call
and retains those bytes, while preserving distinct import contexts for aliases. A later command
captures again instead of trusting modification times or a previous dependency list.

`check` and `build` resolve the same captured graph. `verify` captures current inputs and compares
the logical configuration, source hashes, and resolved edges with the recorded generation; it
does not invoke Tint or Apple's compiler. Continue with
[Build and verify a Metal package](/native/macos/metal/tooling/build).
