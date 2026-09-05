# Exact-static override integration

Status: native semantic extraction, authenticated assembly, exact per-entry translator projection,
deterministic translation, offline Metal compilation, and live render observation passed on the
available Apple M4 Pro.

This slice validates the docs-first override contract already proposed for native programs. Override
values are fixed while building the shader artifact. They are not Swift runtime state, Metal
function constants, or pipeline options.

The program-scoped semantic extractor materializes the exact typed static override sets for all
selected entries. TypeScript now carries those authenticated facts through `semantic-v1`, projects
them into the existing one-entry translator, and reaches Metal without parsing or evaluating WGSL.
One nondegenerate render fixture observes the configured values after they have been baked into the
artifact.

## Keep one configuration and two semantic views

The user-facing configuration uses WGSL's pipeline-overridable constant identifier string. When a
declaration has `@id(17)`, its only key is the base-10 string `"17"`; otherwise its only key is the
authored WGSL name:

```wgsl
@id(17) override SAMPLE_COUNT: u32 = 5u;
override USE_DITHER: bool = false;
```

```json
{
  "name": "Bloom",
  "kind": "effect",
  "source": "./Shaders/Bloom.wgsl",
  "overrides": {
    "17": 9,
    "USE_DITHER": true
  }
}
```

The build adapter validates the object shape and may use resolver reflection for an early
diagnostic, but it preserves the selector for Tint to verify independently. The semantic request
emits `overrideConfiguration` as a strict ascending ASCII array:

```json
[
  { "identifier": "17", "value": 9 },
  { "identifier": "USE_DITHER", "value": true }
]
```

Values remain finite JSON numbers or booleans at this boundary. JavaScript does not infer their
WGSL type, evaluate an initializer, or replace an authored `@id` selector with a declaration name.
Numeric strings are canonical base 10 without a sign or leading zero and fit `0...65535`.

The worker owns both semantic views:

- each entry records the exact static set of resolved WGSL names reported before entry pruning; and
- the result records the canonical typed union of those entry sets after configuration and default
  evaluation.

One result-level record has this shape:

```json
{
  "name": "SAMPLE_COUNT",
  "wgslId": 17,
  "type": "u32",
  "default": { "type": "u32", "value": 5 },
  "selected": { "type": "u32", "value": 9 }
}
```

`selected` is always present. `default` is present only when Tint can evaluate the all-omitted
initializer. Its absence intentionally does not distinguish a missing initializer from an
initializer whose isolated default is unavailable. Boolean and integer values retain their typed
value. Finite `f16` and `f32` values retain canonical lowercase IEEE bit strings.

After the worker consumes the external selector, the resolved WGSL name is semantic identity. An
authored numeric `@id` is retained in the artifact as optional provenance; it does not become a
second internal identity or a runtime function-constant mapping.

## Materialize before pruning

The semantic operation parses and validates the module once, resolves and validates every
configured identifier and value against that module, and then uses fresh lowered IR for each
selected entry and isolated default evaluation. The order is fixed:

1. obtain the selected entry's static override interface from Tint;
2. require values for every member without an initializer;
3. replace configured declarations before evaluating their authored initializers;
4. let Tint evaluate omitted initializers and their dependencies;
5. retain the exact static selected set and resolved positive compute workgroup dimensions; and
6. prune to the selected entry only after the semantic evidence has been fixed.

Configuring an override therefore bypasses its own initializer. Configuring one of its dependencies
may change an omitted dependent value. Configuring a downstream declaration does not waive an
upstream required declaration that remains in the static interface.

A valid configured declaration that no selected entry uses is accepted but omitted from the
semantic result. Later compiler pruning may remove initializer-only dependencies from its internal
effective graph; that does not redefine the required interface, semantic artifact, or translator
request.

The materializer runs inside the semantic worker operation. Launching the existing feasibility
materializer as a second authority would split request association and allow the extraction and
override facts to come from different parses.

## Assemble without reevaluating

Assembly joins every extracted override to resolver-owned declaration evidence. Its
declaration index must retain the authored name, resolved WGSL name, and optional authored `@id`;
raw initializer text remains provenance and is never a value source.

`semantic-v1` stores the program union in strict resolved-name order:

```json
{
  "names": {
    "authored": "SAMPLE_COUNT",
    "wgsl": "SAMPLE_COUNT"
  },
  "swiftName": "SAMPLE_COUNT",
  "wgslId": 17,
  "type": "u32",
  "default": { "type": "u32", "value": 5 },
  "selected": { "type": "u32", "value": 9 }
}
```

The adapter validates exact entry subsets, their union, shared-record agreement, unique resolved
names, unique authored numeric IDs, and Swift presentation. It copies authenticated typed values; it
does not repair, round, or recompute them.

For each entry, compiler request projection selects only that entry's retained names and emits:

```json
{
  "overrides": [
    {
      "name": "SAMPLE_COUNT",
      "value": { "type": "u32", "value": 9 }
    }
  ]
}
```

Defaults, authored names, Swift names, and numeric provenance do not enter the translator request.
The translator independently compares this exact name/type/value set with Tint reflection,
materializes it before `SingleEntryPoint`, and generates ordinary MSL with the values baked in.
`metal-projection-v1` needs no override field because no override decision remains at runtime.

Omitting a configuration value and explicitly configuring it to the same evaluated default must
produce the same normalized semantic program and program fingerprint, even though the extraction
request identities differ. A different selected value or resolved workgroup dimension must change
the fingerprint.

## Executable evidence

The passing semantic-extraction gate freezes eight request fixtures and eight response fixtures. Its
static matrix covers ten prelaunch failures, twenty-four override-response mutations, and
thirty-one existing response mutations. The native run reports forty-seven invocations, including
nine deterministic repeats and eight crossed-request checks. It records five fixture successes,
two inactive-configuration successes, one constant-expression workgroup success, seven semantic
failures, and ten protocol failures.

The extraction evidence covers exact per-entry name subsets and their canonical result-level union,
configured and defaulted typed values, authored `@id` selection and provenance, omission of inactive
configured declarations, and positive workgroup dimensions resolved from constant and
override-dependent expressions. The worker installs the exact typed values into fresh IR before
entry pruning, substitutes overrides, and independently compares the resolved compute dimensions
with the materializer result.

The connected assembly gate adds five override programs to the four existing programs. Nine nominal
assemblies project thirteen compiler requests in total. For overrides specifically, twelve native
translator launches prove six deterministic per-entry translations across five programs. Six
retained MSL sources contain no `function_constant`, compile to AIR for
`air64-apple-macos14.0`, and link into five metallibs. Independent mutations reject missing,
redistributed, or crossed entry subsets even when the program union is unchanged, and reject changed
request or semantic selected values.

## Connected fixtures

The connected gate keeps three complementary designs. All three pass through offline Metal, and the
render fixture additionally passes a live observation.

### Compute materialization

The compute source declares `@id(17) REQUIRED`, `DEP = REQUIRED + 1u`, and an unrelated entry
override. Selecting `needs_required` exercises two configurations:

- `"17" = 4` must preserve exact-static `DEP = 5, REQUIRED = 4` and workgroup size `5 × 1 × 1`;
- `"17" = 4, DEP = 9` must bypass `DEP`'s initializer, preserve the same static membership, and
  produce workgroup size `9 × 1 × 1`.

An unrelated valid configured override remains omitted, and omitting `REQUIRED` fails before
translation. Each success crosses nominal extraction, semantic assembly, exact compiler-request
projection, two deterministic translator processes, AIR compilation, and metallib linking. The
translated resolved workgroup dimensions exactly equal the semantic dimensions.

This fixture deliberately stops before a live compute dispatch. Adding `MetalComputeProgram`, a
compute binder, dispatch ownership, and buffer readback would test a separate runtime contract.

### Render union and observation

The render source uses `SHARED`, `VERTEX_ONLY`, and `FRAGMENT_ONLY`, with configured values that all
differ from their defaults. Both stages use `SHARED`; each also uses its stage-local declaration.
Assembly preserves the different per-entry subsets and their canonical program union, and each
compiler request receives only its own exact subset. Both sources compile and link offline.

Its oversized full-screen vertex path carries the vertex-stage values through a flat varying. The
fragment combines them with its own values and integer pixel coordinates to produce an exact
`2 × 2` signature. Two independent Metal processes each reproduce that signature twice after
loading both functions directly by emitted name. The complete oracle and runtime boundary are
recorded in [`override-metal.md`](./override-metal.md).

### All scalar kinds

An all-scalar companion carries `bool`, `i32`, `u32`, `f16`, and `f32` from authenticated extraction
through assembly, projection, deterministic translation, and offline compilation. Its semantic
request explicitly selects `languageFeatures: ["f16"]`. It reuses the existing materializer and
compiler edge tables rather than introducing another numeric conversion policy.

For every connected fixture, retained MSL does not declare a `function_constant`. The live probe is
also hash-locked, rejects `MTLFunctionConstantValues` and the `constantValues:` overload, and creates
the already-baked functions directly by emitted name.

## Failure matrix

The extraction gate fails closed for:

- unknown configured identifiers, a declaration name used instead of its authored `@id`, malformed
  decimal IDs, wrong scalar kinds, non-integral or out-of-range integers, non-finite floats,
  negative zero, duplicate identifiers, and noncanonical wire order;
- a missing required value, stale dependent default, configured initializer evaluated instead of
  bypassed, or an inactive configuration leaked into the result;
- a missing, extra, reordered, duplicated, or crossed entry override set or program union;
- a typed record with mismatched `type`, `default`, or `selected`, invalid float bits, or an authored
  `wgslId` collision;
- extraction crossed between two configurations of the same source.

Native extraction and translation successes run in fresh processes and must be byte deterministic.
Checked-in responses and hashes remain reviewed oracles rather than being regenerated as part of the
assertion path. Resolver joins, Swift presentation collisions, translator request mutations, Metal
workgroup agreement, exact-union validation, offline-specialization rejection, and live runtime
specialization rejection are now executable.

## Exit condition

The exact-static connected slice is closed: native extraction returns exact typed records, exact
entry subsets, their canonical union, and resolved workgroup dimensions from real requests;
assembly reprojects exactly to that authenticated result; every one-entry translator request
contains the correct subset; retained MSL compiles offline without `function_constant`; and a
nondegenerate render observes configured values without `MTLFunctionConstantValues`.

Passing this connected slice does not add runtime specialization, a public Swift override API,
compute runtime execution, runtime-sized resources, resource binding arrays, repository-corpus
coverage, or production artifact generation.
