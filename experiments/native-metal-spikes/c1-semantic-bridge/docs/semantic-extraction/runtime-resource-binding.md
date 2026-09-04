# Runtime resource binding

Status: executable for the fixed direct render fixture; the production Swift runtime remains open.

This slice connects one nominal Metal program projection to concrete runtime resources without
letting application code restate the physical slot map. It is an internal spike contract, not the
production Swift API proposed in the public documentation.

## Join semantics and physical slots once

The serializable Metal program fragment is intentionally not sufficient to validate a runtime
resource by itself. It owns physical stage-local slots, while `semantic-v1` owns the resource kind
and its constraints:

- buffer address space, access, layout, and minimum binding size;
- texture dimension, sample type, and multisampling;
- sampler kind; and
- per-entry texture/sampler compatibility.

`assembleMetalProgramProjection` retains the exact nominal semantic assembly behind the program
projection. The runtime boundary therefore derives its layout from the projection alone:

```js
const layout = runtimeResourceLayoutForMetalProgramProjection(projection);
```

The function accepts no caller-provided assembly, allocation, descriptors, or slots. A cloned or
deserialized projection has no authority. The resulting frozen nominal layout contains only the
joined runtime facts:

```js
{
  semanticProgram,
  kind,
  bindings: [
    {
      semanticBinding,
      descriptor: {
        kind: "buffer",
        addressSpace: "uniform",
        access: "read",
        minimumBindingSize: 8,
        runtimeSized: false
      },
      slots: [
        {
          stage: "vertex",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: 0,
          count: 1
        },
        {
          stage: "fragment",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: 0,
          count: 1
        }
      ]
    }
  ],
  samplingPairs: [
    { stage: "fragment", texture: "g0b2", sampler: "g0b3", mode: "filtering" }
  ]
}
```

Bindings preserve semantic `(group, binding)` order. Slots preserve canonical stage and resource
class order. Apart from the selected semantic program identity, the layout omits authored and
Swift-facing binding or type names, MSL, compiler candidates, runtime objects, buffer ranges, and
derived storage-size words. Those facts have different owners.

## Bind through one nominal program

The executable Swift probe models the prepare/encode boundary with these internal types:

```swift
let program = try MetalRenderProgram(
  context: context,
  layout: layout,
  pipeline: pipeline
)
let binder = MetalResourceBinder(program: program)
let prepared = try binder.prepare(resources: resources)
try binder.encode(prepared, into: encoder)
```

`MetalRenderProgram` is the nominal owner of the exact context, runtime layout, and
`MTLRenderPipelineState`. `MetalResourceBinder` accepts that program rather than three independently
replaceable values. A prepared plan retains the exact program identity: another binder over the
same program may encode it, while a structurally equivalent program wrapping the same pipeline may
not. The binder validates the encoder's device and installs its retained pipeline before issuing
resource calls.

`prepare` requires exactly one logical value for every semantic binding. Generated Swift binding
sets will provide those values; callers never provide a stage, Metal index, or resource class. The
binder revalidates the layout, then validates the complete set, context and device identity, value
variant, access and usage, buffer slice, texture properties, sampler facts, and sampling pairs. It
may assemble local command records while checking the set, but a failure returns no plan and occurs
before the first Metal `set*` call.

`encode` fans one logical resource out to every verified stage-local slot. In the fixture, one
`frame` buffer reaches both vertex `buffer(0)` and fragment `buffer(0)`, while vertex and fragment
`buffer(1)` refer to different logical resources. Metal buffer, texture, and sampler indices remain
independent namespaces in each stage. This direct model requires `count: 1`; argument buffers and
resource arrays need a new binding model.

## Keep authoritative facts with the resource

A sealed buffer wrapper retains the context that minted it, the Metal object, logical byte length,
vgpu usage, offset, and explicit bound range. Preparation checks the actual `MTLBuffer.device` and
length as well as the retained logical allocation. It rejects ranges below `minimumBindingSize`,
ranges outside the logical allocation, values above the current integer ceiling, and offsets or
storage ranges that are not multiples of four bytes. This is the current profile rule, not a claim
about every future Metal ABI alignment.

A texture wrapper retains only its context and `MTLTexture`. Dimension, sample count, pixel-format
classification, usage, and framebuffer-only state come from the Metal object itself rather than
caller-declared metadata. The live profile fails closed unless the resource is a shader-readable,
non-framebuffer-only, single-sample `texture2d` with `rgba8Unorm` format.

`MTLSamplerState` does not expose enough state to reconstruct its descriptor. The probe's resource
factory therefore mints a sealed sampler wrapper and snapshots the facts this profile needs: minification,
magnification, and mip filters; comparison function; maximum anisotropy; and normalized-coordinate
mode. Preparation derives filtering, non-filtering, or comparison kind from those retained facts.

Instance-owned uniform uploads remain resources at this internal boundary. Their frame-slot and
lifetime policy is upstream of `prepare`; the binder sees an already selected buffer slice and does
not decide which in-flight upload allocation wins.

## Runtime-sized storage remains projection-driven

The live fixture uses only fixed-size buffers. Its program projection has no effective
`internalBindings` and no `storageBufferSizeRegions`; the compiler request's candidate
`immediate-data` reservation never becomes an encode command. The binder explicitly rejects a
runtime-sized descriptor rather than silently treating it as fixed-size.

When runtime-sized storage joins this path, `prepare` must derive size words from effective bound
ranges and the program projection's emitted regions. It must not accept caller-authored words or
promote unused candidate reservations. The existing C1 buffer-size spike remains the range and
word-layout oracle for that later integration.

## Executable evidence

Run the complete gate from the repository root after building the direct worker:

```sh
node experiments/native-metal-spikes/c1-semantic-bridge/gates/semantic-assembly.mjs \
  --worker experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64 \
  --require-worker \
  --require-offline-metal \
  --require-metal-runtime
```

`passed` now requires the runtime execution. An intentional or environmental runtime omission
reports `runtime-skipped`, even when native extraction, translation, and offline Metal compilation
pass.

The recorded Apple M4 Pro run proves:

- 27 static runtime-layout checks and loss of authority after cloning;
- eight semantic extractions and four resource translations, each operation repeated twice;
- two retained MSL sources compiled to AIR and linked into one metallib;
- exact vertex reflection for `frame` and `vertices`, and exact fragment reflection for `frame`,
  `material`, `albedo`, and `albedo_sampler`;
- six prepared commands, including shared-buffer fan-out and independent stage-local `buffer(1)`
  resources;
- 15 named preparation failures for set shape, resource kind, buffer bounds, context, usage, actual
  texture properties, sampler kind, alignment, and runtime-sized rejection;
- two ownership failures crossing prepared plans between distinct nominal programs, even though
  they share one layout and pipeline;
- four strict test-manifest failures for extra root or descriptor data, candidate `buffer(30)`, and
  an invalid emitted Metal name; and
- two byte-identical Swift processes, each validating two renders against exact row-major readback
  `[99, 115, 32, 128, 255, 0, 255, 255, 99, 115, 32, 128, 99, 115, 32, 128]`.

The locked runtime hashes are:

| Evidence       | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| Runtime layout | `6bcc46e2f24801df346251b6d6bab34d3de95e3a044b54aae8159a5577826e1d` |
| Test manifest  | `c4f09a9c78724bf1ccb4e236c41897c4652f0a99efb4c5894152c33224aa2752` |
| Swift probe    | `d6386e348c6d58096b4541240dda625b694207e83857d5b6b75e9c5752f10c15` |
| Readback bytes | `63fc8fde01e08ea5d0018df376c5faed96f2f74bac8cb94af998a9d1bd2331d5` |

The manifest is deterministic test transport for an already derived projection. It is not an
artifact format, public API, or new serializable authority. The Swift probe decodes it strictly and
checks this exact fixture before touching Metal. Pipeline reflection is an independent oracle, not
slot authority.

This is not general resource-runtime evidence. Compute encoding, runtime-sized buffers, binding
arrays, argument buffers, storage or external textures, broader texture formats, production
resource factories, and the supported hardware matrix remain open. The machine exposed one Metal
device, so device guards exist but no crossed-device negative ran; `conditionalDeviceChecks` was
zero. Replacing one dictionary entry after `prepare` also proves only that the prepared plan retains
the selected resource identities, not that arbitrary mutation of underlying Metal objects is safe.
