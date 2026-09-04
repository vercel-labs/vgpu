# C1 follow-up: override materializer to compiler worker

This spike connects the override materializer to the compiler protocol without parsing WGSL or
reimplementing constant evaluation in JavaScript. It asks whether one materializer result contains
enough typed information to construct the worker's exact-static override request.

## Result

Yes. The materializer's separate `staticOverrides` view can be projected directly into the
compiler protocol's exact-static override array. The complete native gate passes four positive
integration cases and two independent worker-negative cases. It invokes the materializer ten times
and the worker twelve times, including deterministic duplicate invocations, and proves that a
missing required value is rejected before the worker runs.

The counterexample is `invalid-initializer.wgsl`. Configuring `A = 7` correctly cuts `A`'s invalid
initializer and removes its initializer-only dependency `X` from effective evidence. The
materializer therefore emits only `A` in `overrides`, while `staticOverrides` preserves
`A = 7, X = 0` for the compiler request. Inventing `X`, parsing its initializer in Node, or weakening
the worker's independent set check would erase the boundary this spike validates.

## Two override views

The local seam adds `staticOverrides` alongside the existing `overrides` array:

- `staticOverrides` contains exactly every override reported for the selected entry point before
  configured initializer cuts or IR pruning. Every item preserves the materializer's rich identity,
  initializer, default-evaluation, and selected-value shape. It is sorted by declaration name.
- `overrides` remains the canonical effective evidence closure after configuration and pruning. It
  must be an item-for-item-identical subset of `staticOverrides`.

The adapter validates both views fail-closed and projects only `{ name, value: selected }` from
`staticOverrides`. It also requires
`verification.exactStaticOverrideCount === staticOverrides.length`; appending an unauthenticated
array to an otherwise valid materializer result is not sufficient. `sourceSha256` must match the
exact UTF-8 WGSL bytes placed in the compiler request, so a materialization cannot be replayed
against changed source that happens to use the same virtual path and override names.

This separation matters even when two configurations produce identical effective evidence or MSL.
The exact-static view still records every value needed to satisfy the selected entry's independent
Inspector reflection.

## Gate

The native gate compiles the existing materializer and compiler worker from their tracked sources
against the same pinned Tint revision. It validates the generated request with the compiler JSON
Schema and semantic checks before launching the worker, then validates the worker response through
the existing trusted decoder. Every materializer and worker success is invoked twice and must be
byte deterministic.

The canaries cover:

- `required-and-subsets.wgsl`, `needs_required`, with `DEP = 9` and `REQUIRED = 4`: effective
  evidence is only `DEP`, while the exact-static request is `DEP = 9, REQUIRED = 4` and resolves the
  X workgroup dimension to `9`;
- the same module's `first` entry with inactive `SECOND = 7`: both views and the request contain only
  `FIRST = 2`; inactive `REQUIRED` needs no value and the workgroup size resolves to `2`;
- `invalid-initializer.wgsl` with `A = 7`: effective evidence is only `A`, the request is
  `A = 7, X = 0`, and the workgroup size resolves to `7` without evaluating the bypassed initializer;
- all five scalar kinds (`bool`, `i32`, `u32`, `f16`, and `f32`) with exact finite floating-point
  bits; configuring `BASE = 5` must reevaluate the dependent `DEP` to `10` instead of copying its
  stale default of `8`; and
- an omitted active `REQUIRED`, which must fail in the materializer before the worker has been
  invoked.

Two additional negative requests prove the worker independently rejects a missing static `X` and
extra inactive `REQUIRED`/`SECOND` values. The adapter's platform-independent gate rejects a missing
static view, noncanonical order, mismatched types or values, duplicate identity, a crossed verified
count, a stale source hash, and conversion of a failed materialization. The native gate also mutates
a real materializer result's source hash and proves it is rejected before another worker launch.

## Reproduce

The platform-independent adapter and source-seam gate run with:

```sh
./experiments/native-metal-spikes/c1-override-worker-integration/run.sh
```

Without dependency roots, the native portion reports `skipped`; it never treats that result as a
native proof.

Run the complete native gate with the same verified dependency roots used by the two upstream
spikes:

```sh
./experiments/native-metal-spikes/c1-override-worker-integration/run.sh \
  --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include ../tint-8f25-compat-include \
  --jsoncpp-root ../jsoncpp-1.9.8 \
  --require-native
```

The runner downloads nothing. It reuses the compiler fixture's pinned Dawn and JsonCpp provenance,
writes executables only below an OS-created temporary directory, and removes that directory on
exit. `.artifacts/` and `.scratch/` are ignored as a guard for local investigation output.

## Scope

This is a local integration contract between two feasibility prototypes. `staticOverrides` is not a
public API, and beyond supplying the required empty compute semantic interface, this spike does not
define shader-interface extraction, artifact persistence, or offline `metal`/`metallib` validation.
The materializer result does not yet authenticate the normalized `languageFeatures` set. The only
overlapping feature is currently `f16`, whose
absence makes an `f16` source fail parsing; broader feature support must either bind that set to the
result or keep it in an inseparable in-process context.
