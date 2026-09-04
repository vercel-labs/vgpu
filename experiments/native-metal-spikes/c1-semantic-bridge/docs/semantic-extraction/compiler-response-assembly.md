# Compiler response assembly

Status: candidate API for the next executable slice.

This slice converts validated one-entry Tint results into one nominal program fragment matching
`$defs/program` in `metal-projection-v1`. It deliberately does not construct the top-level Metal
projection: target, Apple toolchain, linked metallib identity, global ABI policies, runtime
fingerprint, and module-wide requirements belong to later artifact assembly.

## Candidate API

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
```

The compiler request, translation, allocation, assembly, and returned projection are all nominal
in-process values. Cloning or deserializing any one of them intentionally loses its authority.

## Authenticate one translation

`compilerRequestForAssembledEntry` records the exact assembly, allocation, and stage that produced
each frozen request. `authenticateSuccessfulCompilerTranslation` accepts only such a request and:

1. takes one owned structural snapshot of the caller's response;
2. validates that snapshot against compiler response v1;
3. applies the existing request-specific semantic validator;
4. requires `ok: true` and freezes the snapshot; and
5. mints a translation associated with that exact request identity.

The response protocol does not echo a request identity. The trusted one-shot process caller must
therefore preserve the request-to-response association until this function mints the nominal
translation. A raw response is neither self-authenticating nor independently cacheable evidence;
reuse requires its exact request association and the same validation.

MSL remains private retained evidence rather than a field in the serializable program fragment.
`metalSourcesForProgramProjection` returns frozen stage/name/source records only after complete
program assembly succeeds.

## Assemble one program fragment

`assembleMetalProgramProjection` requires exactly one authenticated successful translation for
every selected stage and no others. Input order is irrelevant; output uses canonical vertex,
fragment, compute stage order. Every translation must belong to a request produced from the exact
assembly and allocation passed to the combiner.

Fields have one authority:

- `semanticProgram` and `kind` come from semantic v1;
- `entryPoints[].stage`, `wgsl`, `metal`, and `interface` come from validated response results;
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
no override field. A future program with baked overrides follows this identical combination path.

Internal slots are grouped by role across responses and regain the selected stage omitted by the
one-entry wire shape. A role may contribute at most one slot per stage. Storage-size regions remain
stage-local and require one effective compatible `immediate-data` slot. An effective immediate slot
without a size region remains valid for ordinary immediate values.

Every response in one program must report the same compiler identity. The combiner retains that
identity privately for the later top-level toolchain check. Emitted Metal names must be unique
within the program; module-wide emitted-name uniqueness belongs to final aggregation.

## Independent verification

Before minting the projection, a separate verifier reconstructs the expected program fragment from
the nominal assembly, allocation, and translation records. It checks:

- a bijective selected-stage set with no missing, duplicate, or extra translation;
- exact request ownership and canonical output ordering;
- external bindings equal to the allocator result;
- response-derived entry maps, effective internal slots, and size regions;
- no external/internal or internal/internal interval collision in a stage/class namespace;
- every effective internal slot was a candidate reservation in its request;
- exact compute workgroup dimensions;
- supported empty device requirements; and
- the complete `$defs/program` JSON Schema.

The verifier does not call the assembler or trust fields copied from its output as its expected
model.

## Initial gate

The fixed-resource render fixture should produce two entry records, preserve its five-binding
program allocation, and emit empty `internalBindings`, `storageBufferSizeRegions`, and device
requirements. The candidate `buffer(30)` reservation must not leak into that effective projection.
The two retained MSL sources must still compile to AIR and link into one metallib through the
projection accessor.

Static negatives cover cloned requests and translations; crossed assembly/allocation/request
ownership; schema-invalid and unsuccessful responses; mutated entry, interface, binding, internal,
region, and MSL fields; missing, duplicate, and extra stages; repeated emitted names; compiler
identity disagreement; effective internal slots outside the candidate set or colliding with an
external slot; invalid region relationships; and compute dimensions that differ from semantic v1.
A permutation must normalize to identical output. A separate success canary keeps an effective
immediate slot with no size region.

This slice precedes runtime resource binding. The runtime must consume one validated program
projection rather than recreate a slot union from per-entry responses. Exact-static overrides can
join request construction later without changing this combination boundary.
