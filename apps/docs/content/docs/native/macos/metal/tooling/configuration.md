---
title: "Configure a Metal package"
description: "Select WGSL entry points and an owned output directory for a generated Swift package."
---

A native configuration selects the shader programs that ship together in one Swift package.
It does not describe your application's pipelines, resource allocations, render passes, or frame loop.

> Beta: The parser, help, lazy dispatch, `doctor`,
> `check`, `build`, and `verify` are implemented. Local-tarball tests install offline with dependency install
> scripts disabled and exercise build publication to an initially absent destination. An external
> Swift consumer executes the resulting compute and render programs on this host. The companion
> is an optional public beta. See
> [Local installed qualification](/native/macos/metal/tooling/publication#local-installed-qualification)
> for replacement and recovery coverage; broad release compatibility remains unqualified.

## Select the programs

Create `vgpu.native.json` beside your shader directory. The configuration must be a regular UTF-8
JSON file no larger than one MiB:

```json
{
  "schemaVersion": 1,
  "moduleName": "AppShaders",
  "programs": [
    {
      "name": "Gradient",
      "source": "shaders/gradient.wgsl",
      "entryPoints": {
        "vertex": "vertex_main",
        "fragment": "fragment_main"
      }
    },
    {
      "name": "Count",
      "source": "shaders/count.wgsl",
      "entryPoints": { "compute": "count_main" }
    }
  ],
  "output": "Generated/AppShaders"
}
```

Use the `Gradient` source from [Pack uniforms for Metal](/native/macos/metal/uniforms) and the small
imported `Count` source from [Resolve shader inputs](/native/macos/metal/tooling/sources).
[Dispatch WGSL compute](/native/macos/metal/compute/dispatch) provides a separate runtime-array
`Count` variant with different bindings and results. Each guide identifies its implemented profile
and remaining validation work.

`moduleName` names the Swift module and library product. A program's `name` names its generated
Swift type: `Gradient.load(device:)` and `Count.load(device:)` in this example. Names must be safe,
unambiguous Swift identifiers; unsupported names fail validation instead of being silently renamed.

A render program selects exactly one vertex and one fragment entry. A compute program selects
exactly one compute entry. Entry names are authored WGSL names, not emitted Metal function names.
You cannot combine render and compute stages in the same program record.

The versioned configuration rejects unknown fields. This initial command profile does not configure
shader overrides, extra language features, custom compiler binaries, or an alternative backend.
Those options need explicit compiler contracts, not passthrough flags.

## Resolve paths from the configuration

`source` and `output` are relative to the configuration's directory, regardless of the shell's
working directory. Use forward slashes in configuration paths. Relative WGSL imports remain
relative to the module that imports them. Imported modules follow vgpu's purity rules; resource
and entry declarations stay in the entry shader.

See [Resolve shader inputs](/native/macos/metal/tooling/sources) for how captured source bytes,
package imports, and dependency changes become build inputs.

Project commands use `./vgpu.native.json` by default. They do not search parent directories.
Select a file explicitly in a monorepo:

```sh
npx vgpu native check --config ./apps/example/vgpu.native.json
```

Validation uses the selected programs and their resolved dependencies. A file that is not in that
graph is not automatically another program. Referencing a shader from Swift also does not remove
the other configured programs from the compiled library: one configuration is one shader payload.
Use separate configurations and output directories when you need separate packages.

## Reserve a generated directory

The output directory belongs to the tool. Keep handwritten Swift and other application files
outside it. The build writes the package source, compiled library, and a hidden ownership and
integrity record as one output.

The first build accepts a missing or empty destination. Replacing a nonempty directory requires a
matching ownership record and an unchanged set of tool-owned files. Modified generated files and
unexpected files are reported instead of being discarded. There is no force flag that bypasses
ownership checks.

Filesystem roots, the home directory, the configuration directory or its ancestors, an ancestor of
any resolved source input, and symlinked output paths are not valid destinations. These checks
include the physical targets of input aliases and every existing component of the output path.
Components are checked before simplifying `.` or `..`: `Link/../Generated` is rejected when `Link`
is a symbolic link, even if the simplified destination would be safe. A regular file in that
position is rejected too. Missing components do not end the inspection; a later `..` can return
to an existing directory whose next component still needs checking. This preflight creates nothing.
A valid destination boundary does not establish ownership of an existing package; replacement
still requires the unchanged ownership and file checks above. Changing the configured output does not
delete the previous directory. Move or remove an old package yourself after updating its consumers.

## Keep toolchain targets explicit

The current generated package declares Swift tools version `6.0` and macOS `14` as its deployment
floor. Offline compilation targets Metal `2.4`. These are artifact settings, not evidence that every
machine at those versions has passed testing. The release matrix must separately establish build-host,
consumer-toolchain, and physical GPU coverage.

The package has no external Swift dependencies. Its app-facing contents are generated Swift and
a compiled `.metallib`; Node.js and the WGSL translator remain build-time tools. See
[Load Metal functions](/native/macos/metal/functions) for adding it to a Swift consumer, then
[Build and verify a Metal package](/native/macos/metal/tooling/build) for regeneration and checks.
