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

> Warning: The snapshot helpers are implemented and tested, including serialized replay, package
> imports, relocation, and bounded direct file reads. The internal Metal compiler accepts captured
> graphs as well as explicit module maps, with real compute and render tests. Native doctor, check,
> build, and verify also run from real local tarballs installed offline with dependency install scripts
> disabled; build coverage publishes to an initially absent destination, and an external Swift
> consumer executes those actual published compute and render programs on this host. The companion
> is an optional public beta. See
> [Local installed qualification](/native/macos/metal/tooling/publication#local-installed-qualification)
> for replacement and recovery coverage; the broad release compatibility remains unqualified.

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

The intended command performs this step for you. Build-tool integrations can use the WGSL helpers
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

Tooling that accepts a mutable snapshot can first call `copyShaderGraphSnapshot(snapshot)` from
`@vgpu/wgsl/runtime`. It synchronously validates the data shape, source limits and hashes, then
returns an owned, deeply frozen copy before asynchronous work begins. Accessor properties and
custom object prototypes are not snapshot data. Copying does not replace replay's import-graph,
purity, and shader checks.

`resolveShaderSnapshot` uses only captured source and edges. It performs ordinary import, purity,
emission, and reflection checks without reading files or resolving packages again. Its `validate`
and `minify` options have the same meaning as `resolveShader`; native tooling disables WebGPU
validation and minification before running the pinned Metal compiler boundary. Capture itself
does not validate WGSL semantics or prove that a shader belongs to the supported Metal profile.

The initial snapshot records source and import choices, not a package-resolution warning log.
Replay reports the WGSL diagnostics it can reproduce from that data; it does not recreate warnings
about a package's conditional exports. The existing filesystem `resolveShader` API retains those
package-resolution diagnostics.

## Bound input reads

Source files must be regular, valid UTF-8 files without NUL bytes. The initial capture limits are
four MiB per source module, thirty-two MiB of captured module bytes, 1,024 graph modules, and 128
modules along an import chain. Package manifests read directly by vgpu must be regular UTF-8 JSON
files no larger than one MiB. Exceeding a limit fails the capture; it does not truncate source or
return a partial graph. These limits are not command-line tuning flags.

Fallbacks delegated to Node or package-manager resolver hooks retain those resolvers' own I/O
behavior. The direct-read limits do not establish bounded execution or compatibility for every
package manager, virtual filesystem, or custom hook.

Capturing is not an atomic snapshot of the entire filesystem. Finish edits and dependency
installation before running a native command. Capture reads each resolved module once per call
and retains those bytes, while preserving distinct import contexts for aliases. A later command
captures again instead of trusting modification times or a previous dependency list.

`check` and `build` resolve the same captured graph. `verify` captures current inputs and compares
the logical configuration, source hashes, and resolved edges with the recorded generation; it
does not invoke Tint or Apple's compiler. Continue with
[Build and verify a Metal package](/native/macos/metal/tooling/build).

## Identify a generation

The input fingerprint describes the module name, selected programs and entry points, captured
source hashes and import edges, and the native generation profile. The profile includes the pinned
WGSL compiler and protocol, artifact format, generation revision, and Metal, Swift, and deployment
settings that affect the generated package.

Absolute checkout paths, the output destination, configuration formatting, and program listing
order do not make otherwise identical inputs stale. The owning configuration is checked separately
from this fingerprint. Changing a shader, a captured logical import edge, an entry point, or the generation
profile does make the output stale, including changes to imported declarations that are unused.

Generation revisions track changes to source resolution, shader interpretation, bindings, or Swift
emission. A documentation-only or command-line-only tooling update does not require regeneration
just because its npm version changed. Verification does not run the installed Apple tools to
compare their versions; the fingerprint does not promise identical compiled library bytes across
different Xcode or Metal compiler versions.
