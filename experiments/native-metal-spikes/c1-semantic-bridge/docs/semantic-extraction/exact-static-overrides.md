# Exact-static override integration

Status: design selected; the connected extraction-to-Metal gate is the next C1 slice.

This slice validates the docs-first override contract already proposed for native programs. Override
values are fixed while building the shader artifact. They are not Swift runtime state, Metal
function constants, or pipeline options.

The remaining hypothesis is narrow: the program-scoped semantic extractor can materialize the exact
typed static override sets for all selected entries, and TypeScript can carry those authenticated
facts through `semantic-v1` and the existing one-entry translator without parsing or evaluating WGSL.

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

Assembly joins every extracted override to resolver-owned declaration evidence. The next resolver
declaration index revision retains the authored name, resolved WGSL name, and optional authored
`@id`; raw initializer text remains provenance and is never a value source.

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

## Executable fixtures

The connected gate uses three complementary programs. Compute and render cross the complete
build-time path; the all-scalar companion closes typed transport without adding another runtime
path.

### Compute materialization

The compute source declares `@id(17) REQUIRED`, `DEP = REQUIRED + 1u`, and unrelated entry
overrides. Selecting `needs_required` exercises two configurations:

- `"17" = 4` produces exact-static `DEP = 5, REQUIRED = 4` and workgroup size `5 × 1 × 1`;
- `"17" = 4, DEP = 9` bypasses `DEP`'s initializer but preserves the same static membership and
  produces workgroup size `9 × 1 × 1`.

An unrelated valid configured override is accepted and omitted. Omitting `REQUIRED` fails before
translation. Each success crosses nominal extraction, semantic assembly, exact compiler-request
projection, two deterministic translator processes, AIR compilation, and metallib linking. The
translated resolved workgroup dimensions must exactly equal the semantic dimensions.

This fixture deliberately stops before a live compute dispatch. Adding `MetalComputeProgram`, a
compute binder, dispatch ownership, and buffer readback would test a separate runtime contract. The
worker's independent IR comparison plus Apple's offline compiler close the build-time override
hypothesis without that expansion.

### Render union and observation

The render source has `SHARED`, `VERTEX_ONLY`, and `FRAGMENT_ONLY`. Both stages use `SHARED`; each
also uses its stage-local declaration. The extractor must return different per-entry subsets and one
canonical program union. Each compiler request receives only its own exact subset.

Configured non-default values affect the rendered color. Both retained MSL sources compile and link,
then machinery shared with the existing resource-free Metal render harness creates a pipeline and
checks an exact 2 × 2 readback. The current hard-coded full-screen probe may be parameterized or
receive a sibling; it is not reused unchanged. This observes the baked result without adding an
override API to Swift or using `MTLFunctionConstantValues`.

### All scalar kinds

An all-scalar companion carries `bool`, `i32`, `u32`, `f16`, and `f32` through extraction, assembly,
projection, deterministic translation, and offline compilation. Its semantic request explicitly
selects `languageFeatures: ["f16"]`. It reuses the existing materializer and compiler edge tables
rather than inventing another numeric conversion policy.

For every fixture, the gate rejects retained MSL that declares a `function_constant`. The Swift
runtime probe must not construct `MTLFunctionConstantValues`; pipeline creation consumes the already
baked functions directly.

## Failure matrix

The gate fails closed for:

- unknown configured identifiers, a declaration name used instead of its authored `@id`, malformed
  decimal IDs, wrong scalar kinds, non-integral or out-of-range integers, non-finite floats,
  negative zero, duplicate identifiers, and noncanonical wire order;
- a missing required value, stale dependent default, configured initializer evaluated instead of
  bypassed, or an inactive configuration leaked into the result;
- a missing, extra, reordered, duplicated, or crossed entry override set or program union;
- a typed record with mismatched `type`, `default`, or `selected`, invalid float bits, or an authored
  `wgslId` collision;
- extraction crossed between two configurations of the same source, or resolver name/ID evidence
  crossed between programs;
- a Swift reserved name or case-insensitive collision in the generated override scope;
- a compiler request with a missing, extra, crossed, or changed selected value; and
- semantic, translator, or projected compute workgroup dimensions that disagree; or
- a generated Metal function constant or runtime specialization attempt.

Every handled failure occurs before MSL is accepted. Native successes run in fresh processes and
must be byte deterministic. Checked-in responses and hashes remain reviewed oracles rather than
being regenerated as part of the assertion path.

## Exit condition

The slice closes when all three programs are derived from real resolved source, native extraction
returns the exact typed records, assembly reprojects exactly to that authenticated result,
every one-entry translator request contains the correct subset, all MSL compiles offline, and the
render fixture produces the exact expected readback twice in independent processes. Retained MSL
contains no `function_constant`, and the Swift probe creates no `MTLFunctionConstantValues`.

Passing this gate does not add runtime specialization, a public Swift override API, compute runtime
execution, runtime-sized resources, resource binding arrays, the repository corpus, or production
artifact generation. No API decision in this slice remains tied.
