# Compiler response assembly

Status: executable for resource-free effect/draw and compute programs, singular fixed buffer,
sampled-texture, and sampler resources, and runtime-sized compute storage with effective immediate
data and an authenticated storage-size region.

This slice converts validated one-entry Tint results into one nominal program fragment matching
`$defs/program` in `metal-projection-v1`. It deliberately does not construct the top-level Metal
projection: target, Apple toolchain, linked metallib identity, global ABI policies, runtime
fingerprint, and module-wide requirements belong to later artifact assembly.

## Executable API

```js
const request = compilerRequestForAssembledEntry({
  assembly,
  allocation,
  stage: "fragment",
  metalEntryPoint: "vgpu_example_fragment",
});

const response = await invokeCompiler(request);
const translation = authenticateSuccessfulCompilerTranslation({
  request,
  response,
});

const projection = assembleMetalProgramProjection({
  assembly,
  allocation,
  translations: [vertexTranslation, translation],
});

const sources = metalSourcesForProgramProjection(projection);
const runtimeLayout =
  runtimeResourceLayoutForMetalProgramProjection(projection);
```

The compiler request, translation, allocation, assembly, and returned projection are all nominal
in-process values. Cloning or deserializing any one of them intentionally loses its authority.

## Authenticate one translation

`compilerRequestForAssembledEntry` records the exact assembly, allocation, and stage that produced
each frozen request. `authenticateSuccessfulCompilerTranslation` accepts only such a request and:

1. rejects a request without the nominal assembly-owned brand before inspecting response data;
2. takes one owned structural snapshot of the caller's response;
3. validates that snapshot against compiler response v1;
4. applies the existing request-specific semantic validator;
5. requires `ok: true` and freezes the snapshot; and
6. mints a translation associated with that exact request identity.

The response protocol does not echo a request identity. The trusted one-shot process caller must
therefore preserve the request-to-response association until this function mints the nominal
translation. A raw response is neither self-authenticating nor independently cacheable evidence;
reuse requires its exact request association and the same validation.

MSL remains retained evidence rather than a field in the serializable program fragment. The
trusted combiner can inspect the frozen request and response through internal accessors while
assembling and verifying the program. Runtime and packaging consumers instead call
`metalSourcesForProgramProjection`, which returns frozen `{ stage, entryPoint, msl }` records only
after complete program assembly succeeds.

## Assemble one program fragment

`assembleMetalProgramProjection` requires exactly one authenticated successful translation for
every selected stage and no others. Input order is irrelevant; output uses canonical vertex,
fragment, compute stage order. Every translation must belong to a request produced from the exact
assembly and allocation passed to the combiner.

Fields have one authority:

- `semanticProgram` and `kind` come from semantic v1;
- `entryPoints[].stage`, `wgsl`, and `metal` come from the nominal request, and the authenticated
  response must repeat them exactly;
- `entryPoints[].interface` comes from the response only after it matches both the request's exact
  semantic-interface projection and semantic v1;
- external `bindings` are copied from the nominal program allocation, because Tint can validate and
  reproduce a requested map but cannot recover the original WGSL identity after remapping;
- effective `internalBindings` and `storageBufferSizeRegions` come only from response results, never
  from candidate request reservations;
- compute `resolvedWorkgroupSize` comes from the response and must equal the semantic entry's
  authenticated dimensions; render programs omit it; and
- `deviceRequirements` come from a separate semantic-to-Metal projector.

The requirements projector consumes only the semantic program from the nominal assembly; callers
cannot supply requirements to the combiner. Its first executable profile returns
`{ features: [], limits: [], formats: [] }` only after proving that the program has no semantic
execution feature with unimplemented lowering, no binding with a static format requirement such as
a storage texture, and no other known program-local requirement without a mapper. WGSL language
features are build-environment inputs, not Metal device requirements. The later top-level assembler
forms and validates the canonical module union without reinferring or replacing program results.

The combiner neither requires nor inspects an empty override set. Exact per-entry overrides are
authenticated when each nominal compiler request is minted, and the Metal program projection has
no override field. The connected baked-override programs follow this identical combination path.

Internal slots are grouped by role across responses and regain the selected stage omitted by the
one-entry wire shape. A role may contribute at most one slot per stage. Storage-size regions remain
stage-local and require one effective compatible `immediate-data` slot. An effective immediate slot
without a size region remains valid for ordinary immediate values.

The later top-level projection always serializes and fingerprints both
`immediateDataLayoutModel` and `storageBufferSizeModel`. Runtime compatibility is intentionally
conditional at a finer boundary: support for the immediate layout model is required when the
selected stage has an effective `immediate-data` slot, even with no size region; support for the
storage-size model is required only when that stage has a `storageBufferSizeRegions` record.

Every response in one program must report the same compiler identity. The combiner retains that
identity privately for the later top-level toolchain check. Emitted Metal names must be unique
within the program; module-wide emitted-name uniqueness belongs to final aggregation.

## Independent verification

Before minting the projection, a separate verifier reconstructs the expected program fragment from
the semantic program and layout graph, allocation, and translation records. It checks:

- a bijective selected-stage set with no missing, duplicate, or extra translation;
- structural request/semantic/allocation agreement and canonical output ordering;
- external bindings equal to the allocator result;
- response-derived entry maps, effective internal slots, and size regions;
- no external/internal or internal/internal interval collision in a stage/class namespace;
- every effective internal slot was a candidate reservation in its request;
- every size region belongs to a stage with an active runtime-sized storage buffer and one
  compatible effective immediate-data slot;
- exact compute workgroup dimensions;
- supported empty device requirements; and
- the complete `$defs/program` JSON Schema.

The verifier does not call the assembler or trust fields copied from its output as its expected
model.

## Executable gate

The static gate emits nine program fragments from thirteen authenticated synthetic translations;
the full assembly matrix contains ten programs, ten nominal allocations, and fourteen compiler
requests. The runtime-sized request is deliberately reserved for real Tint. Every input permutation
normalizes to the same program.
The fixed-resource fragment preserves its five-binding allocation and emits empty
`internalBindings`, `storageBufferSizeRegions`, and device requirements. The candidate `buffer(30)`
reservation does not leak into that effective projection. Two retained MSL sources compile to AIR
and link into one metallib exclusively through the projection accessor.

Static negatives cover cloned requests and translations; crossed assembly/allocation/request
ownership; schema-invalid and unsuccessful responses; mutated entry, interface, binding, internal,
region, and MSL fields; missing, duplicate, and extra stages; repeated emitted names; compiler
identity disagreement; effective internal slots outside the candidate set or colliding with an
external slot; invalid region relationships; and compute dimensions that differ from semantic v1.
A permutation must normalize to identical output. A separate success canary keeps an effective
immediate slot with no size region. An independent positive canary validates a runtime-sized
storage buffer, effective immediate slot, and size region together; mutations cover the same
region without a runtime-sized layout, an unreserved internal slot, an external/internal collision,
an extra stage, and caller-authored device requirements. The current run records nineteen
authentication/combination failures, fourteen independent verifier canaries, and four requirements
projector checks.

The resource-free full-screen gate crosses the same boundary before execution. Both AIR
compilation and live function lookup read MSL and emitted names only through the nominal projection
accessor; two deterministic 2x2 readbacks pass on the available Apple M4 Pro.

The fixed-resource gate now crosses the boundary too. It derives one frozen resource layout from
the nominal program projection, combines the retained semantic constraints with the exact projected
slots, and binds only through a program that owns that layout and its pipeline. The runtime never
recreates a slot union from per-entry responses. See
[`runtime-resource-binding.md`](./runtime-resource-binding.md) for the executable proof and its
fixed-profile limits. Exact-static overrides now cross the same combination boundary, compile and
link offline, and one render program passes a live readback without runtime specialization. See
[`exact-static-overrides.md`](./exact-static-overrides.md) for that connected evidence.

The runtime-sized compute entry translates twice with byte-identical real Tint responses and
assembles the tenth nominal projection. It preserves external `buffer(0)`, effective immediate-data
`buffer(30)`, and a size region at byte `4`, then compiles and links offline. On the available M4
Pro, each of two live processes runs two dispatches that reuse one backing allocation and binding
offset with effective ranges `28` and `52`, upload `[0, 28]` and `[0, 52]`, and read back
`[2, 202]` and `[4, 404]` respectively.
