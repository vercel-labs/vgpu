# Authenticated semantic-extraction contract

The semantic extractor is a third operation in the one-shot vgpu Tint worker. It authenticates one
finalized source capsule and returns exactly the backend-neutral facts needed to assemble one
selected render or compute program. It does not select programs, invent Swift names, allocate Metal
slots, or generate MSL.

The contract is program-scoped rather than module-scoped. A render request always selects one
vertex and one fragment entry together; a compute request selects exactly one compute entry. This
lets the worker resolve cross-stage resource kinds atomically while TypeScript remains the owner of
`effect`, `draw`, and `compute` policy.

## Request

The request uses `vgpu-native-tint-semantic-extraction/v1`:

The placeholders below stand for values in the selected target shape for the next override slice;
the checked-in request fixtures will contain concrete hashes, byte ranges, and source text. The
current executable profile still requires an empty `overrideConfiguration`; its schema, JavaScript
validator, C++ decoder, and oracles migrate to `identifier` together in that slice.

```json
{
  "schemaVersion": 1,
  "contractId": "vgpu-native-tint-semantic-extraction/v1",
  "source": {
    "virtualPath": "generated/Gradient.resolved.wgsl",
    "sha256": "<sha256 of exact UTF-8 WGSL>",
    "text": "<exact finalized WGSL>"
  },
  "originMap": {
    "schemaVersion": 1,
    "contractId": "vgpu-native-origin-map/v1",
    "generatedSource": {
      "virtualPath": "generated/Gradient.resolved.wgsl",
      "sha256": "<same source sha256>"
    },
    "sources": [
      { "input": "Shaders/Gradient.wgsl", "sha256": "<authored sha256>" }
    ],
    "segments": [
      {
        "generated": { "startByte": 0, "endByte": 384 },
        "origin": { "input": "Shaders/Gradient.wgsl" },
        "precision": "module"
      }
    ]
  },
  "originMapSha256": "<sha256 of canonical origin-map JSON>",
  "entryPoints": [
    { "stage": "vertex", "wgsl": "vs_main" },
    { "stage": "fragment", "wgsl": "fs_main" }
  ],
  "overrideConfiguration": [
    { "identifier": "17", "value": 9 },
    { "identifier": "USE_DITHER", "value": true }
  ],
  "languageFeatures": []
}
```

`source`, `originMap`, `originMapSha256`, and `languageFeatures` reuse the inventory invariants
without weakening them. The source path and origin input IDs are NFC caller identities; WGSL text
is preserved exactly and is never Unicode-normalized.

`entryPoints` has one of two exact shapes:

- one compute entry; or
- one vertex followed by one fragment entry.

The request deliberately has no `programKind`. Whether a render pair is an effect or draw, and
whether the vertex entry was authored or injected, are TypeScript facts. The worker only needs the
selected WGSL names and stages.

`overrideConfiguration` is module-scoped, sorted by pipeline-overridable constant identifier, and
contains no duplicates. It accepts finite canonical JSON numbers and booleans; negative zero is
rejected because the deterministic JSON encoding would otherwise collapse it to zero. Tint validates
and converts each value against the declaration's scalar type. A declaration with an authored
`@id(17)` is identified only by the canonical base-10 string `"17"`; otherwise its WGSL name is the
identifier. Automatic Tint IDs are implementation details and never become selectors. A valid
configured declaration that is inactive in the selected program is accepted but omitted from the
result.

## Request identity

The official TypeScript producer encodes the request by sorting object keys while preserving every
string code unit. The response repeats:

```text
SHA-256(UTF-8("vgpu-native-tint-semantic-extraction-request-bytes/v1")
  || 0x00
  || exact encoded request bytes)
```

The worker calculates this identity from stdin bytes before decoding. A schema-valid response can
only be accepted with the retained request object, its exact encoded bytes, the expected local
compiler identity, and the matching identity. This is request association, not a signature: trust
still comes from launching the pinned local executable.

## Success

A success has the common compiler identity and diagnostic envelope plus one semantic result:

```json
{
  "schemaVersion": 1,
  "contractId": "vgpu-native-tint-semantic-extraction/v1",
  "ok": true,
  "requestIdentity": {
    "domain": "vgpu-native-tint-semantic-extraction-request-bytes/v1",
    "sha256": "<sha256>"
  },
  "compiler": {
    "name": "vgpu-tint-compiler",
    "version": "0.1.0",
    "protocol": 1,
    "upstream": { "name": "dawn/tint", "revision": "<pinned revision>" }
  },
  "diagnostics": [],
  "result": {
    "entryPoints": [
      {
        "stage": "vertex",
        "wgsl": "vs_main",
        "semanticInterface": {
          "kind": "vertex",
          "inputs": [
            {
              "type": { "scalar": "u32", "width": 1 },
              "invariant": false,
              "builtin": "vertex_index"
            }
          ],
          "outputs": [
            {
              "type": { "scalar": "f32", "width": 2 },
              "invariant": false,
              "location": 0,
              "interpolation": { "type": "perspective", "sampling": "center" }
            },
            {
              "type": { "scalar": "f32", "width": 4 },
              "invariant": false,
              "builtin": "position"
            }
          ]
        },
        "bindings": [],
        "samplingPairs": [],
        "overrides": []
      },
      {
        "stage": "fragment",
        "wgsl": "fs_main",
        "semanticInterface": {
          "kind": "fragment",
          "inputs": [
            {
              "type": { "scalar": "f32", "width": 2 },
              "invariant": false,
              "location": 0,
              "interpolation": { "type": "perspective", "sampling": "center" }
            }
          ],
          "outputs": [
            {
              "type": { "scalar": "f32", "width": 4 },
              "invariant": false,
              "location": 0
            }
          ]
        },
        "bindings": [],
        "samplingPairs": [],
        "overrides": []
      }
    ],
    "bindings": [],
    "overrides": [],
    "types": {},
    "layouts": {}
  }
}
```

The two allowed `entryPoints` tuple shapes match the request exactly. Each entry contains:

```text
stage, wgsl, semanticInterface, bindings, samplingPairs, overrides
```

A compute entry additionally contains the resolved positive `workgroupSize`; render entries must
omit it. `semanticInterface` uses the translator request's exact `{ kind, inputs, outputs }` shape.
Its leaves contain an inline `{ scalar, width }` type, `invariant`, and exactly one of `location` or
`builtin`, plus interpolation or blend-source metadata only where the semantic contract permits
it. TypeScript interns that type into a semantic type ID during assembly. The extractor omits the
optional diagnostic `name`: core IR can prove the flattened interface leaf, but not that a
synthesized lowered name came from authored WGSL.

`bindings` is the canonical program union. Entry-local binding IDs identify the exact active set,
and entry-local sampling pairs identify the exact sampled relationships. `overrides` is the
canonical union of each entry's exact-static override set. Types and layouts contain only the
transitive closure reachable from active buffer bindings; interface scalar/vector types are
interned from their inline facts instead of redundantly appearing in that graph. The detailed
normalization rules live in
[Sampling, resources, and types](./sampling-and-types.md).

### Current executable profile

The current implementation accepts interface-only programs plus singular active resources whose
buffer graphs have fixed host-shareable layouts. `overrideConfiguration` must remain empty and no
selected entry may use an active override. It extracts complete stage I/O, literal compute
workgroup sizes, exact entry-local binding subsets and sampling pairs, the numeric program binding
union, and the reachable content-addressed type and layout graphs.

The primary render fixture contains bindings `b0`, `b1`, `b2`, `b3`, and `b10`. Its vertex subset
contains the shared frame uniform and vertex storage buffer; its fragment subset contains the same
frame uniform, sampled texture, sampler, and material uniform. The response contains seven types,
six layouts, and fixed buffer minimum sizes of 8, 24, and 16 bytes. Separate native canaries prove
an authored fixed `@size`, a storage texture, and cross-stage unknown sampler/texture resolution.

Runtime-sized buffers and resource binding arrays produce structured unsupported failures rather
than approximate success. Configured overrides and active overrides also remain unsupported.
Constant-expression and override-expression workgroup dimensions join the override slice. These
are executable-profile restrictions, not omissions from the v1 response shape.

The selected integration contract, three-fixture gate, and failure matrix are specified in
[`exact-static-overrides.md`](./exact-static-overrides.md).

## Failure and process model

A handled failure uses the same contract and request identity, sets `ok` to `false`, contains at
least one error diagnostic, and omits `result`. Invalid UTF-8, incomplete framing, I/O failures, and
crashes remain nonzero transport failures whose stdout is untrusted.

One decoded request produces one response and exits. The worker parses WGSL once for Inspector and
module validation, then creates a fresh lowered IR for each selected entry and for any isolated
override-default pass. Reusing a mutated per-entry IR would make stage order observable and is not
accepted.

The TypeScript adapter schema-validates and semantically validates the response, deep-freezes the
accepted value, and brands its exact object identity. Cloning, serialization, or crossing it with a
different retained request loses that authority.
