# MediaPipe hand model pair provenance

Audit record for the two ONNX graphs the hand-estimation spike converts from
Google's official **MediaPipe Hand Landmarker** bundle: a palm **detector** and a
hand **landmark** model.

Nothing here is staged into `apps/docs/public/models/` yet. The converted bytes
currently exist only inside the untracked `/hand-gate/` payload, because the plan
makes the author-run gate a hard stop before any production integration. This
directory is the tracked half: the recipe, the hashes, and the license reading.

## Upstream source

| Field | Value |
| --- | --- |
| Publisher | Google |
| Model | MediaPipe Hand Landmarker (hand_landmarker) |
| Artifact | `.task` bundle, float16, version 1 |
| Download | `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` |
| Model card | `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf` |
| Documentation | `https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker` |
| Retrieved | 2026-07-27 |

The URL is version-pinned (`/float16/1/`) and additionally pinned here by
content hash. The `.task` bundle is a plain zip containing exactly two TFLite
graphs, each pinned separately so that a repack of the bundle cannot slip a
different graph past the check.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `hand_landmarker.task` | 7,819,105 | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `hand_detector.tflite` (bundle member) | 2,339,878 | `945f713bc23570bd4ed60f848c401dc8eaf95713183d43ba14cf12e467d27a7d` |
| `hand_landmarks_detector.tflite` (bundle member) | 5,478,949 | `6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9` |

The three sizes match the ones the plan measured independently before this work
started, which is a second confirmation that the pinned URL is still serving the
same bytes.

## Verified identity of the converted files

**`tf2onnx` is not byte-reproducible, so a raw SHA-256 cannot be the contract
here.** This was measured, not assumed: converting the same `hand_detector.tflite`
seven times, on the same machine, with the same pinned toolchain, produced seven
files of *identical length* and seven *different* SHA-256 digests.

```
49d01da944d7a352e845440bc712f148cc452f75ecdcf86259df9e38f0d4ee89  run 1
97627dbf9449aa45642b8d1d7265793b3f0aba5210648941bd29c400eefbd914  run 2
4ceefd830174d8f200fa9f977c59b2b31dfcca62411b907d6d52b3636583265a  run 3
```

The cause is small and boring. `tf2onnx` names generated tensors from a
process-global counter, so the first differing initializer is `scales__278` in
one run and `scales__301` in the next, and every later generated name shifts with
it. Setting `PYTHONHASHSEED=0` does not fix it. The graphs are otherwise
identical: node count, node order, node names and the **multiset of initializer
contents** all compare equal across runs.

The contract is therefore a **canonical structural digest** (`graph-digest.py`):
a SHA-256 over the opsets, the I/O signature, every node in topological order,
and every initializer's dtype/shape/contents — with generated names normalised
away by content-addressing every edge. It was confirmed stable across all seven
conversions.

| File | Bytes | MiB | Graph digest (reproducible) |
| --- | --- | --- | --- |
| `palm-detector.onnx` | 4,589,374 | 4.38 | `a19a133771a070d26591f473695b5cbcffb1af148c7b5165162eed8aeefd6ac2` |
| `hand-landmark.onnx` | 10,903,457 | 10.40 | `416a84388303c48900c5edafc3f06d28126e0baf8772860af1c19e9d8a2052cc` |
| **combined** | **15,492,831** | **14.78** | — |

The byte counts above are those of the copies staged under
`apps/docs/public/models/mediapipe-hands/`, which were produced by the original
`tf2onnx` 1.16.1 / TensorFlow 2.15.1 toolchain. The current pinned toolchain
(`tf2onnx` 1.17.0 / TensorFlow 2.19.0 / `onnx` 1.22.0) emits files 2 bytes
shorter — 4,589,372 and 10,903,455 — with **both graph digests unchanged**, so
`convert.sh` carries the shorter lengths. See "Caveat on bit-exactness".

`convert.sh` fails hard if a graph digest or a file size changes; a byte-level
difference alone is expected and is reported, not treated as an error. Byte
digests of the specific staged copies are written to `SHA256SUMS` next to the
models, and the gate page verifies the files it is served against that file — an
integrity check on one copy, which is a genuine and useful guarantee, just not a
reproducibility claim.

> Note for a future reader: `apps/docs/examples/air-painting/convert-model/README.md`
> asserts that "`tf2onnx` output is deterministic for a fixed input file and a
> fixed toolchain". On this evidence that assertion is wrong. The MoveNet digest
> may still happen to hold if that graph allocates a stable number of generated
> names, but the general claim does not. Those files are out of scope for this
> change and were left untouched.

**Payload note, recorded rather than glossed over.** The plan's target for the
checked-in payload is ≤12 MiB with a hard review at 16 MiB. The measured pair is
**14.78 MiB**: inside the review cap, over the target. This is the honest
consequence of the float16 TFLite dequantising to float32 during a mechanical
ONNX conversion — the `.task` bundle is 7.46 MiB, the ONNX pair is roughly twice
that. It is a real trade-off for phase 2 to decide with the gate's evidence in
hand, not something to hide. Options if the author rejects the size: ship the
detector at float32 and explore an ONNX float16 pass on the landmark model only
(requires its own parity evidence), or accept 14.78 MiB. No compression or
quantisation has been applied here, because doing so silently would break the
"whatever tf2onnx emits is what ships" property the MoveNet recipe established.

## Graph contracts after conversion

Dumped with `graph-dump.py`; both are opset 18, IR version 8.

### `palm-detector.onnx`

- input `input_1`, **float32**, `[1, 192, 192, 3]` (NHWC, values in `[0,1]`)
- output `Identity`, float32, `[1, 2016, 18]` — per-anchor box + 7 palm keypoints
- output `Identity_1`, float32, `[1, 2016, 1]` — per-anchor logit
- 144 nodes: `Conv` 63, `PRelu` 31, `Add` 30, `MaxPool` 4, `Reshape` 4, `Pad` 3,
  `Transpose` 5, `Resize` 2, `Concat` 2

### `hand-landmark.onnx`

- input `input_1`, **float32**, `[1, 224, 224, 3]` (NHWC, values in `[0,1]`)
- output `Identity`, float32, `[1, 63]` — 21 xyz landmarks, **in crop pixels**
- output `Identity_1`, float32, `[1, 1]` — hand presence
- output `Identity_2`, float32, `[1, 1]` — handedness
- output `Identity_3`, float32, `[1, 63]` — 21 world landmarks
- 97 nodes: `Conv` 47, `Clip` 32, `Add` 9, `Gemm` 4, `Sigmoid` 2, `ReduceMean` 1,
  `Transpose` 2

**No custom-domain operator appears in either graph.** The only declared opset
domains are `""` (18) and `ai.onnx.ml` (2), and `ai.onnx.ml` is declared but
unused — every node is a standard `ai.onnx` operator. `convert.sh` fails hard if
a dump ever mentions `com.microsoft`, `ai.onnx.contrib` or a `custom` domain.

Two contract facts that contradict the naive expectation and are worth stating
explicitly:

1. **float16 TFLite does not mean float16 ONNX I/O.** Both converted graphs take
   and return float32. That is convenient here — it is exactly what the plan's
   float32 GPU-buffer crop input needs — but it was verified, not assumed.
2. **Landmark output `Identity` is in crop pixels, not normalised.** Values run
   to ~224, so the host divides by 224 before applying the inverse ROI
   transform. `hand_pipeline.decode_landmarks` is the reference.

## What the models do *not* contain

This is the most important line in this file. Converting two graphs is not
converting the MediaPipe hand pipeline. Absent from both ONNX files, and
therefore host work:

- SSD anchor generation (2016 anchors: 24×24×2 at stride 8, 12×12×6 at stride 16)
- sigmoid + score threshold + **weighted** NMS
- palm keypoints → rotated ROI (`DetectionsToRects`, keypoint 0 → keypoint 2,
  target angle 90°) and `RectTransformation` (scale 2.6, shift_y −0.5, square_long)
- the rotated crop itself
- the landmark → next-ROI loopback, the detector-on-loss cadence, and two-hand
  track association

`hand_pipeline.py` in this directory is the reference transcription of all of
the above, and `validate-cpu.py` exercises it end to end on real photographs.

## License and redistribution

MediaPipe models are published by Google under the **Apache License, Version
2.0**; the hand-tracking model card and the MediaPipe repository both state it.
`LICENSE` in this directory is the Apache 2.0 text.

Apache-2.0 permits reproducing and distributing the work and derivative works,
including a format-converted copy, provided the license and notices travel with
it and modified files are identified. This section is that identification:

> **Modification notice.** `palm-detector.onnx` and `hand-landmark.onnx` are not
> upstream Google artifacts. They were produced from the two TFLite graphs inside
> the upstream `hand_landmarker.task` bundle listed above by a mechanical format
> conversion (TFLite → ONNX) with the pinned toolchain below. Weights are
> unchanged apart from the converter's own dtype/layout handling; the float16
> TFLite constants are materialised as float32. No retraining, pruning, or
> quantization was applied by this repository.

This is a license reading recorded for review, not legal advice.

### Third-party artifacts deliberately not used

The plan lists OpenCV Zoo's MediaPipe ONNX exports and PINTO model zoo #033 as
comparators. **No byte from either is used or redistributed here.** Both were
consulted only as documentation of the postprocessing semantics. The conversion
above starts from Google's own version-pinned file, so the lineage is direct.

## Reproducible conversion recipe

Local Docker was unavailable on the machine that produced these files, so a
pinned virtual environment was used instead of a container digest. Host:
aarch64 Linux, Python 3.11.2.

The staged models were produced with `tf2onnx` 1.16.1 / TensorFlow 2.15.1
(resolving to the `tensorflow-cpu-aws==2.15.1` wheel) / `onnx` 1.17.0 — the same
pins the MoveNet recipe used. `requirements-convert.txt` now pins `tf2onnx`
1.17.0 / TensorFlow 2.19.0 / `onnx` 1.22.0, which retires the CVE-2025-51480
exposure the old `onnx` pin had to accept. The change was gated on the
reproducibility contract: the newer toolchain emits **both recorded graph
digests unchanged**, and `validate-cpu.py` over both fixtures reproduces the
recorded golden landmark-for-landmark. Only the byte lengths shrank by 2 each.

```bash
tools/models/mediapipe-hands/convert.sh /tmp/hand-conversion
```

which is, unrolled:

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/models/mediapipe-hands/requirements-convert.txt

curl -fL --max-time 300 \
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task' \
  -o hand_landmarker.task
# sha256 fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1

python3 -c "import zipfile; z=zipfile.ZipFile('hand_landmarker.task'); \
  [open(n,'wb').write(z.read(n)) for n in ('hand_detector.tflite','hand_landmarks_detector.tflite')]"

.venv/bin/python -m tf2onnx.convert --tflite hand_detector.tflite \
  --output palm-detector.onnx --opset 18
.venv/bin/python -m tf2onnx.convert --tflite hand_landmarks_detector.tflite \
  --output hand-landmark.onnx --opset 18
```

`convert.sh` additionally verifies every digest in this file and refuses to
continue on a mismatch.

### Caveat on bit-exactness

`tf2onnx` output is **not** bit-exact across runs; see "Verified identity of the
converted files" above for the measurement. Only the structural graph digest is
reproducible, and in general even that is only guaranteed for a fixed toolchain:
a different `tf2onnx`/`onnx`/protobuf build may legitimately emit a different but
equivalent graph. A graph-digest mismatch therefore means "your toolchain
differs or the weights changed" — dump both graphs and diff them before assuming
the worse of the two.

In this recipe's one measured toolchain change that caveat did **not** bite.
Moving from `tf2onnx` 1.16.1 / TensorFlow 2.15.1 / `onnx` 1.17.0 to `tf2onnx`
1.17.0 / TensorFlow 2.19.0 / `onnx` 1.22.0 (protobuf 3.20.3 → 5.29.6,
ml-dtypes 0.3.2 → 0.5.4) reproduced both graph digests exactly —
`a19a1337…` over 144 nodes / 140 initializers and `416a8438…` over 97 nodes /
105 initializers — while the byte lengths shrank by 2 each. So the structural
digest survived a four-minor TensorFlow jump and a protobuf major, which is
stronger evidence for it as the contract than the single-toolchain measurement
above could give.

## Offline validation performed

`validate-cpu.py` ran both graphs through onnxruntime 1.20.1's CPU EP on the
fixture photographs recorded in `image-credits.md`, with the full host pipeline
from `hand_pipeline.py`. Measured results:

| Fixture | Accepted detections | Presence | Landmarks in crop | Landmarks in expanded box | Fingertips in box |
| --- | --- | --- | --- | --- | --- |
| `two-hands-sky.jpg` | 2 | 0.990 / 0.995 | 21/21 both | 21/21 both | 5/5 both |
| `one-hand-rotated.jpg` | 1 | 0.954 | 21/21 | 21/21 | 5/5 |

The two-hand fixture's ROI rotations are +72.5° and −59.8°, and the one-hand
fixture's is +87.8°, so the rotated-crop path is genuinely exercised rather than
degenerating to an axis-aligned crop. MCP-centroid separation on the two-hand
fixture is far above the 0.05 floor the validator enforces.

One observation worth carrying into threshold tuning: on unrelated photographs
the detector produced palm boxes scoring 0.58 that the landmark model then
rated at presence **0.017–0.044**. Detector score is not evidence of a hand;
**presence is the gate**, which is exactly why the plan forbids carrying a stale
detector score as current confidence.
