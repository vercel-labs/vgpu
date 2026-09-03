---
title: "Compare WebGPU and Metal"
description: "Run one canonical fixture through WebGPU and Metal, then compare normalized pixels and exact logical traces."
---

`native compare` renders an explicit fixture through `vgpu/node` and the generated Metal package. The fixture owns every dynamic input; neither backend reads wall-clock time or display size.

> Warning: Native macOS support is a docs-first API proposal. The command and fixture format on this page are not implemented yet.

## Define a fixture

This two-pass fixture renders `Gradient` offscreen and samples it with `Present`:

```json
{
  "schemaVersion": 1,
  "output": {
    "size": [320, 180],
    "format": "rgba8unorm",
    "colorSpace": "linear",
    "alphaMode": "straight"
  },
  "resources": {
    "scene": {
      "kind": "target",
      "format": "rgba16float"
    },
    "linear": {
      "kind": "sampler",
      "minFilter": "linear",
      "magFilter": "linear"
    }
  },
  "instances": {
    "gradient": {
      "program": "Gradient",
      "bindings": {
        "params": {
          "time": 1.5,
          "size": [320, 180],
          "accent": [0.35, 0.55, 1.0]
        }
      }
    },
    "present": {
      "program": "Present",
      "bindings": {
        "source": { "target": "scene", "aspect": "color" },
        "sourceSampler": { "resource": "linear" }
      }
    }
  },
  "frame": [
    {
      "target": "scene",
      "clear": [0, 0, 0, 0],
      "draw": ["gradient"]
    },
    {
      "target": "$output",
      "clear": [0, 0, 0, 0],
      "draw": ["present"]
    }
  ],
  "tolerance": {
    "maxChannelDelta": 2,
    "maxDifferentPixels": 0
  }
}
```

The fixture is a validation format, not a runtime render graph. It is never included in the application and does not constrain dynamic Swift control flow.

## Run the comparison

```sh
npx vgpu native compare \
  --fixture ./Fixtures/gradient-present.json \
  --out ./artifacts/gradient-present
```

`compare` runs `native verify` first and refuses to use a stale artifact. The generated package includes an `AppShadersMetalRunner` executable target used only by tests. The CLI compiles it with Swift on a cache miss, keyed by the artifact hash, Metal-runner ABI, Swift runner target triple, and Swift toolchain.

The CLI and runner exchange one versioned JSON request and response over standard input and output. The protocol is explicitly Metal-specific and is recorded under `projection.testing`; it is excluded from runtime compatibility and never linked into the application product.

Before writing the request, the CLI validates the author-facing fixture, materializes every default, turns keyed resources, instances, and bindings into records with explicit IDs, resolves blend and write-mask state per color attachment, and represents floating-point values by their IEEE 754 bits. The runner therefore receives one canonical form rather than interpreting user shorthand.

The runner returns either a typed error or the Metal-device identity, a hashed top-origin RGBA8 image encoded inline, and a versioned logical-command trace. Runner transport and harness failures use `VGPU-NATIVE-METAL-RUNNER-*` codes; semantic failures shared with the runtime keep their existing codes.

## Read the results

The command writes:

```text
artifacts/gradient-present/
  webgpu.png
  metal.png
  diff.png
  result.json
```

Both backends render `$output` into an offscreen texture with the declared format, color space, and alpha representation. Readback normalizes row order and channel order to top-origin, 8-bit RGBA; it does not include a presentation surface or apply an implicit color conversion or unpremultiplication. Alpha is included.

A pixel differs when any channel exceeds `maxChannelDelta`, an integer from `0` through `255`; the command fails when the differing pixel count exceeds `maxDifferentPixels`.

The tolerance applies only to normalized pixel output. Generated conformance tests compare packed binding bytes, buffer readbacks, logical command order, fingerprints, and shared semantic error codes exactly. Backend-internal resource transitions are not a cross-platform comparison contract.

A passing fixture proves parity on the recorded WebGPU and Metal devices. It does not promise identical floating-point results on every GPU or add an untested device to the supported matrix. The first alpha's release comparisons run on Apple silicon; Intel and AMD GPUs require their own physical results before support expands.

## Next steps

- [Build and verify native artifacts](/native/macos/build)
- [Inspect generated artifacts](/native/macos/artifacts)
- [Compose native rendering primitives](/native/macos/rendering)
