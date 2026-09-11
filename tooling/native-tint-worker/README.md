# Native Tint worker build tooling

This directory owns the pinned source-build recipe, compiler worker, protocol validators, request
fixtures, and provenance used by `packages/native`. It is developer tooling, not a Swift runtime,
an npm installer, or a bundled compiler release.

The four sibling directories retain their existing `c1-*` names because the authenticated source
and request closures include those relative paths. Their historical names do not make them
disposable experiments. Keep the worker sources, schemas, validators, locks, and licenses together:

- `c1-tint-direct-build` contains the reproducible build gate and accepted source lock.
- `c1-compiler-protocol` contains the worker implementation and translation protocol inputs.
- `c1-semantic-bridge` contains the retained inventory/extraction schemas, validators, and canaries.
- `c1-tint-standalone` retains only the reference-release provenance needed by the independent oracle.

The [build recipe](./c1-tint-direct-build/README.md) documents the exact required source checkouts,
toolchain, and gate. It does not download or install prerequisites. For argument help only:

```sh
bash tooling/native-tint-worker/c1-tint-direct-build/run.sh --help
```

An ordinary gate invocation invalidates its own `.artifacts` cache before building. Do not run it
as a read-only check or while native tests use that cache. Candidate generation is a separate,
reviewed workflow; a changed binary hash never authorizes widening the consumer's trusted list.

Native tests use the authenticated arm64 worker at
`c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64`. Binaries, copied license notices,
reports, external source checkouts, and temporary build trees remain untracked. A relocated cache
preserves existing build evidence; copying and hash-checking it is not a new source-build result.
The source lock and all four tracked license inputs remain unchanged during relocation.

The compiler process is independent of GPU execution. Its reproducible arm64/x86_64 builds and
Rosetta checks do not establish Intel or AMD GPU support. Real Metal compilation and consumer
tests belong to `packages/native`, whose supported integration profile can be narrower than these
compiler canaries.
