# MediaPipe hand model pair provenance

This directory holds redistributed, format-converted copies of the two neural
graphs inside Google's **MediaPipe Hand Landmarker** bundle, used by the
`air-painting` docs example. They are served same-origin so the example performs
no third-party download at runtime.

Two files, because MediaPipe's hand solution is two models: a **palm detector**
that finds hands in a whole frame, and a **landmark model** that reads 21 points
out of one tight, rotated crop. Neither is useful alone, and neither contains the
host-side geometry that connects them — see "What is not in these files" below.

## Upstream source

| Field | Value |
| --- | --- |
| Publisher | Google |
| Model | MediaPipe Hand Landmarker (`hand_landmarker`) |
| Artifact | `.task` bundle, float16, version 1 |
| Download | `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` |
| Documentation | `https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker` |
| Model card | `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf` |
| Retrieved | 2026-07-27 |

The URL is version-pinned by its `/float16/1/` path segment and additionally
pinned here by content hash. The `.task` file is a plain ZIP containing exactly
two TFLite graphs, both of which are pinned separately:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `hand_landmarker.task` | 7,819,105 | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `hand_detector.tflite` | 2,339,878 | `945f713bc23570bd4ed60f848c401dc8eaf95713183d43ba14cf12e467d27a7d` |
| `hand_landmarks_detector.tflite` | 5,478,949 | `6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9` |

## Verified bytes of the redistributed files

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `palm-detector.onnx` | 4,589,374 (4.38 MiB) | `836e25f3f6d365cd7a67c36ad69876c3da9b540cb434a26e9d100a00938cfd2e` |
| `hand-landmark.onnx` | 10,903,457 (10.40 MiB) | `6d98325697613ffb250a29bedd78450f87ecf1968797f9c54829cda45b44c00c` |

`sha256sums` in this directory is the checked-in digest; verify with
`sha256sum -c sha256sums`. These are actual bytes, not Git LFS pointers.

### Payload size, stated plainly

Combined, **14.78 MiB**. The plan's review cap for checked-in models is 16 MiB
and its target is 12 MiB, so this is inside the cap and **over the target**. The
author's hardware gate reported it as an advisory warning rather than a failure,
and it ships as-is, but it is genuinely larger than the 8.97 MiB MoveNet file it
replaces and that trade is worth naming.

Where the size goes: the upstream TFLite graphs are float16, but `tf2onnx`
dequantizes on conversion, so the ONNX weights are float32 and roughly double.
The obvious lever is re-emitting float16 ONNX, which was not done here because it
changes the graph digest, needs the whole offline and on-hardware validation
repeated, and depends on ONNX Runtime WebGPU float16 support that this repository
has not measured. That is a deliberate follow-up, not an oversight.

## Graph contracts

Measured off the converted files, not copied from a model card. Both graphs are
**float32 in and out**, despite the upstream bundle being float16: the model card
would have led you to the wrong input tensor.

### `palm-detector.onnx`

- input `input_1`, float32, `[1, 192, 192, 3]` (NHWC RGB, `[0,1]`)
- output `Identity`, float32, `[1, 2016, 18]` — 4 box terms + 7 palm keypoints
- output `Identity_1`, float32, `[1, 2016, 1]` — one logit per anchor
- 144 nodes, opset 18

### `hand-landmark.onnx`

- input `input_1`, float32, `[1, 224, 224, 3]` (NHWC RGB, `[0,1]`)
- output `Identity`, float32, `[1, 63]` — 21 xyz **in crop pixels**, not normalized
- output `Identity_1`, float32, `[1, 1]` — hand presence
- output `Identity_2`, float32, `[1, 1]` — handedness
- output `Identity_3`, float32, `[1, 63]` — 21 world xyz
- 97 nodes, opset 18

Neither graph contains a custom-domain operator; the conversion script fails
loudly if one ever appears.

## What is not in these files

MediaPipe ships most of its hand pipeline as graph *configuration*, not as
weights. None of the following is in either ONNX file, and all of it is
reimplemented in `examples/air-painting/hand-pipeline.ts`:

- SSD anchor generation (2,016 anchors over four feature layers)
- sigmoid, logit clamping and score thresholding
- **weighted** non-maximum suppression, which blends each cluster rather than
  picking one winner
- the palm-box-to-rotated-ROI transform, including the 2.6x expansion and the
  shift along the hand's own axis
- the crop itself, and the inverse transform back to frame coordinates
- the landmark-to-next-ROI loopback that lets the detector be skipped

Converting the two graphs was the easy half. A successful `tf2onnx` run proves
only that the tensors move.

## License and redistribution

The MediaPipe models are published by Google under the Apache License 2.0, and
`LICENSE` in this directory is that text. Apache-2.0 permits reproducing and
distributing the work and derivative works, including a format-converted copy,
provided the license and notices travel with it and modified files are
identified. This file is that identification:

> **Modification notice.** `palm-detector.onnx` and `hand-landmark.onnx` are not
> upstream Google artifacts. They were extracted from the upstream float16
> `.task` bundle listed above and converted from TFLite to ONNX by a mechanical
> format conversion with the pinned toolchain below. Weights are unchanged apart
> from the converter's own dtype/layout handling — notably float16 to float32. No
> retraining, pruning, or quantization was applied by this repository.

This is a license reading recorded for review, not legal advice.

## Reproducible conversion recipe

The full script, with hash verification and graph inspection, is
`tools/models/mediapipe-hands/convert.sh`. Local Docker was unavailable on the
machine that produced these files, so a pinned virtual environment was used
instead of a container digest. Host: aarch64 Linux, Python 3.11.2. TensorFlow
resolved to the `tensorflow-cpu-aws==2.15.1` wheel on that platform.

The files in this directory were produced by that toolchain (`tf2onnx` 1.16.1 /
TensorFlow 2.15.1 / `onnx` 1.17.0). `requirements-convert.txt` has since been
bumped to `tf2onnx` 1.17.0 / TensorFlow 2.19.0 / `onnx` 1.22.0 to retire a CVE
in the old `onnx` pin. Re-running `convert.sh` today therefore yields files 2
bytes shorter than the ones here, **with both graph digests below unchanged** —
the graphs, and the CPU validation results, are identical. These copies were
kept rather than re-staged; `sha256sums` describes exactly these bytes.

```bash
tools/models/mediapipe-hands/convert.sh --work /tmp/hand-conversion
```

### Bit-exactness: the honest version

**`tf2onnx` output is not byte-reproducible**, and the MoveNet recipe in this
repository previously claimed otherwise. Seven conversions of the same input
TFLite, on the same machine, with the same pinned toolchain, produced seven
identically sized files with seven different SHA-256 digests. `PYTHONHASHSEED=0`
does not fix it.

The cause is benign: `tf2onnx` names generated tensors from a process-global
counter, so unrelated prior allocations shift later names (`scales__278` versus
`scales__301`). Node count, node order, operator order and the multiset of
initializer contents all compare equal, so the weights are provably identical.

The reproducibility contract is therefore a **canonical graph digest** — a hash
over opsets, the I/O signature, every node in topological order, and every
initializer's dtype, shape and raw contents, with generated names normalized away
by content-addressing each edge:

| File | Canonical graph digest |
| --- | --- |
| `palm-detector.onnx` | `a19a133771a070d26591f473695b5cbcffb1af148c7b5165162eed8aeefd6ac2` |
| `hand-landmark.onnx` | `416a84388303c48900c5edafc3f06d28126e0baf8772860af1c19e9d8a2052cc` |

Compute it with `tools/models/mediapipe-hands/graph-digest.py`. It was stable
across all seven detector conversions and all three landmark conversions.

The byte digests recorded above pin *these copies*, which is what protects the
redistributed files. A graph-digest mismatch means the toolchain differs or the
weights changed, and is worth investigating; a byte mismatch on a fresh
conversion means nothing on its own.

## Validation

Offline, through the ONNX Runtime CPU execution provider, on two
Creative-Commons photographs (`tools/models/mediapipe-hands/image-credits.md`):

| Image | Hands kept | Detector score | Presence | ROI rotation |
| --- | ---: | ---: | ---: | ---: |
| Open Hands Facing The Heavens | 2 | 0.866 / 0.735 | 0.990 / 0.995 | +72.5° / −59.8° |
| Pride.be 2018 DSC08078 | 1 | 0.693 | 0.954 | +87.8° |

All 21 landmarks fell inside both the crop and the expanded palm box for every
accepted hand.

Two further candidate photographs are worth recording as negatives: they scored
**0.578** and **0.583** at the detector and came back with hand presence **0.044**
and **0.017**. Confident-looking palms that the landmark model refused to vouch
for. That gap is why the example gates the brush on presence and never on a
carried-over detector score.

In the browser, on the author's Apple M4 Pro (Chrome, ONNX Runtime Web 1.27.0,
WebGPU EP), via the fail-closed `/hand-gate/` page:

| Measurement | Result |
| --- | --- |
| Verdict | `HAND_GATE_PASS`, 0 required failures |
| Tracked frame (2 landmark runs) | p50 5.8 ms, p95 6.0 ms (budget 50 ms) |
| Acquisition frame (detector + 2 landmarks) | p50 36.1 ms, p95 41.5 ms (budget 100 ms) |
| Output residency | every run `gpu-buffer`, float32, contracted dims |
| Sessions | both on one shared `GPUDevice` |
| GPU-buffer crop input | accepted; 2.8e-07 mean abs error against the CPU reference |
| Golden agreement | centroid deltas ≤ 0.00124 normalized |

The gate page itself is untracked local tooling; the evidence JSON is at
`/home/user/airpaint-gate/author-hand-evidence.json`.
</content>
