# Reproducing `public/models/movenet/movenet-lightning.onnx`

This directory is **tooling, not example source**. It is deliberately absent from
`meta.files`, is never imported by `index.tsx` or `renderer.ts`, and adds no
dependency to the docs app. Nothing here runs at build time or at page runtime.

Run it only when the checked-in model must be re-derived or audited.

## What it does

Downloads the official Google MoveNet.SinglePose.Lightning float16 TFLite
artifact, converts it to ONNX with a pinned `tf2onnx` toolchain, and verifies the
result against the hashes recorded in
`apps/docs/public/models/movenet/PROVENANCE.md`.

## Requirements

- Python 3.11 (the recorded run used 3.11.2 on aarch64 Linux)
- Network access to `tfhub.dev` / `kaggle.com`
- ~2 GB of disk for the pinned TensorFlow wheel

A container would be preferable for a digest-pinned environment. Docker was not
available on the machine that produced the checked-in file, so the recipe pins
exact package versions instead and pins the *outputs* by SHA-256, which is what
actually protects the redistributed bytes.

## Usage

```bash
./convert.sh /tmp/movenet-conversion
sha256sum -c ../../../public/models/movenet/SHA256SUMS
```

The script fails loudly if either the downloaded TFLite bytes or the produced
ONNX bytes do not match the recorded digests.

## Expected results

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `movenet-singlepose-lightning-float16-v4.tflite` | 4,758,512 | `0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab` |
| `movenet-lightning.onnx` | 9,402,989 | `0f4ca5f5049e8b43ee976f25f05f3455aa0cc66cafb50bc5f378b68a558a684b` |

Graph contract after conversion (inspect with `graph-dump.py`):

- input `serving_default_input:0`, **uint8**, `[1, 192, 192, 3]`
- output `StatefulPartitionedCall:0`, float32, `[1, 1, 17, 3]`
- 207 nodes, opset 18

The uint8 input contradicts the published model card's `int32` claim. See
`PROVENANCE.md`; the example implements uint8.

## Caveat on bit-exactness

`tf2onnx` output is deterministic for a fixed input file and a fixed toolchain,
which is why the digest check above is meaningful. It is *not* guaranteed across
different `tf2onnx`/`onnx`/protobuf builds, so a mismatch means "your toolchain
differs", not necessarily "the weights differ". Diff the graph before assuming a
problem.
