# movenet-lightning.onnx provenance

This directory holds a redistributed, format-converted copy of Google's
**MoveNet.SinglePose.Lightning** pose estimator used by the `air-painting` docs
example. It is served same-origin so the example performs no third-party
download at runtime.

## Upstream source

| Field | Value |
| --- | --- |
| Publisher | Google |
| Model | MoveNet.SinglePose.Lightning |
| Artifact | TFLite, float16, version 4 |
| Download | `https://tfhub.dev/google/lite-model/movenet/singlepose/lightning/tflite/float16/4?lite-format=tflite` |
| Resolved page | `https://www.kaggle.com/models/google/movenet/tfLite/singlepose-lightning-tflite-float16/1?tfhub-redirect=true` (TFHub redirects to the versioned Kaggle model page) |
| Model card | `https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf` |
| Retrieved | 2026-07-27 |

The upstream artifact is immutable by version and additionally pinned here by
content hash:

| Field | Value |
| --- | --- |
| TFLite size | 4,758,512 bytes |
| TFLite SHA-256 | `0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab` |

## Verified bytes of the redistributed file

| Field | Value |
| --- | --- |
| File | `movenet-lightning.onnx` |
| Size | **9,402,989 bytes (8.97 MiB)** |
| SHA-256 | `0f4ca5f5049e8b43ee976f25f05f3455aa0cc66cafb50bc5f378b68a558a684b` |

`SHA256SUMS` in this directory is the checked-in digest; verify with
`sha256sum -c SHA256SUMS`. The plan's review cap for a checked-in model is
16 MiB and its target is 12 MiB, so 8.97 MiB is inside both. These are actual
bytes, not a Git LFS pointer.

## License and redistribution

The official MoveNet.SinglePose model card states, verbatim:

> "Licensed Under Apache License, Version 2.0"

`LICENSE` in this directory is the Apache License 2.0 text. Apache-2.0 permits
reproducing and distributing the work and derivative works, including a
format-converted copy, provided the license and notices travel with it and
modified files are identified. This file is that identification:

> **Modification notice.** `movenet-lightning.onnx` is not an upstream Google
> artifact. It was produced from the upstream float16 TFLite file listed above by
> a mechanical format conversion (TFLite → ONNX) with the pinned toolchain below.
> Weights are unchanged apart from the converter's own dtype/layout handling. No
> retraining, pruning, or quantization was applied by this repository.

This is a license reading recorded for review, not legal advice.

## Reproducible conversion recipe

Local Docker was unavailable on the machine that produced this file, so a pinned
virtual environment was used instead of a container digest. Host:
aarch64 Linux, Python 3.11.2. TensorFlow resolved to the
`tensorflow-cpu-aws==2.15.1` wheel on that platform.

```bash
python3 -m venv .venv
.venv/bin/pip install pip==24.3.1 tf2onnx==1.16.1 onnx==1.17.0 \
  onnxruntime==1.20.1 pillow==11.1.0 tensorflow==2.15.1

curl -L --fail --max-time 60 \
  'https://tfhub.dev/google/lite-model/movenet/singlepose/lightning/tflite/float16/4?lite-format=tflite' \
  -o movenet-singlepose-lightning-float16-v4.tflite

.venv/bin/python -m tf2onnx.convert \
  --tflite movenet-singlepose-lightning-float16-v4.tflite \
  --output movenet-lightning.onnx --opset 18
```

The converter reported `tensorflow=2.15.1, onnx=1.17.0, tf2onnx=1.16.1/15c810`.
No graph simplification, folding, or FP16 pass was applied afterwards: the file
is exactly what `tf2onnx` emitted. The script and a longer walk-through live in
`apps/docs/examples/air-painting/convert-model/`.

## Model contract (as inspected, not as assumed)

| Field | Value |
| --- | --- |
| ONNX IR version | 8 |
| Opsets | `""` 18, `ai.onnx.ml` 2 |
| Input | `serving_default_input:0`, **uint8**, `[1, 192, 192, 3]` NHWC RGB, values `0..255`, no mean/std normalization |
| Output | `StatefulPartitionedCall:0`, float32, `[1, 1, 17, 3]` |
| Nodes | 207 |
| Operators | Add 19, ArgMax 2, Cast 10, Clip 35, Concat 5, Conv 74, Div 3, GatherND 4, Mul 7, Relu 7, Reshape 13, Resize 3, Sigmoid 2, Split 2, Sqrt 1, Squeeze 4, Sub 6, Transpose 4, Unsqueeze 6 |

Output semantics are MoveNet's `[y, x, score]` per keypoint, `y`/`x` normalized
to the (letterboxed) input frame and `score` in `[0, 1]`. Keypoint order is
COCO: nose, left/right eye, left/right ear, left/right shoulder,
left/right elbow, **left wrist = 9**, **right wrist = 10**, left/right hip,
left/right knee, left/right ankle. The example always uses index 10.

### Input dtype: uint8, not int32

The public model card describes the input as `int32`. The **float16 TFLite
artifact actually published under that model card exports `uint8`**, and the
converted ONNX therefore has a `uint8` input. This was measured on the graph, not
inferred, and confirmed at runtime by ONNX Runtime Web:

```text
OrtRun ERROR_CODE 2: Unexpected input data type.
Actual: (tensor(int32)), expected: (tensor(uint8))
```

`uint8` is the contract this example implements
(`examples/air-painting/pose-contract.ts` is the single source of truth). The
consequence is documented in the example copy: the **camera preprocessing is
CPU-side** (mirror + letterbox into a `Uint8Array`, uploaded as an ORT input
tensor per inference), while the **landmark output stays GPU-resident and is
consumed zero-copy**.

## Real-hardware evidence for this exact file

Measured by the repository author on discrete GPU hardware in Chromium with
ONNX Runtime Web 1.27.0, WebGPU execution provider only,
`preferredOutputLocation: 'gpu-buffer'`:

| Field | Value |
| --- | --- |
| Model bytes loaded | 9,402,989 |
| Execution providers | `['webgpu']` |
| Output location | `gpu-buffer` |
| Output type / dims | `float32`, `[1, 1, 17, 3]` |
| Output `gpuBuffer` size | 256 bytes |
| Cold fetch + session create | 214.2 ms |
| Warm runs | 100 |
| Warm p50 / p95 | **9.7 ms / 12.2 ms** (min 6.8, max 16.7) |
| Gate floor | p95 ≤ 66 ms (≥15 Hz) — passed with ~5× margin |
| GPU-buffer *input* probe | failed: int32 tensor rejected against the uint8 input (see above) |

Two COCO val2017 single-person photos produced plausible in-frame wrist
keypoints; the right-wrist values are pinned in
`examples/air-painting/fixtures.ts` as `EVIDENCE_KEYPOINTS` so a regression in
the letterbox/unletterbox math is caught by unit tests.

Software rasterizers (SwiftShader/Lavapipe) are **not** able to complete
`session.run` for this graph in reasonable time; a >75 s unresolved first run was
observed. That is a host limitation, not a model defect, and it is why every
local test in this repository is either ORT-free or golden-based.

## Test imagery

The two COCO val2017 images used for the correctness check are **not** committed.
They were gate-time fixtures only, supplied under the COCO terms referenced by
the model card. Only the resulting keypoint numbers are recorded here and in
`fixtures.ts`.
