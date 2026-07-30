# MediaPipe hand models: conversion, offline validation, gate staging

This directory is **tooling, not example source**. It is deliberately absent from
any `meta.files`, is never imported by the docs app, and adds no dependency to
the build. Nothing here runs at build time, at page runtime, or in CI.

It supports phases 0–2 of the air-painting hand-estimation swap: produce the two
ONNX graphs from Google's official bundle, prove them offline on the CPU, and
stage the untracked `/hand-gate/` payload the author runs on real hardware.

**No production code has been changed.** The swap is gated on the author's M4
`HAND_GATE_PASS`.

## Files

| File | Role |
| --- | --- |
| `convert.sh` | Downloads the pinned `hand_landmarker.task`, verifies it, extracts and verifies both TFLite graphs, converts each to ONNX, verifies the ONNX digests, dumps both contracts, rejects custom-domain ops. |
| `graph-dump.py` | Prints the ONNX contract (I/O dtypes/dims, operator histogram, opsets) that `PROVENANCE.md` records. |
| `hand_pipeline.py` | Pure-Python reference for everything the two graphs do **not** contain: SSD anchors, weighted NMS, palm→rotated-ROI, the rotated crop, the inverse transform, the MCP centroid, and the landmark→next-ROI loopback. |
| `validate-cpu.py` | Runs both graphs through onnxruntime's CPU EP over fixture photographs, checks geometry and presence, and can render overlay PNGs. |
| `stage-gate.sh` | Rebuilds the untracked `apps/docs/public/hand-gate/` payload: both models, the pinned ORT runtime, the fixtures, and the CPU golden. |
| `requirements-convert.txt` | The pinned conversion toolchain. Carries the same current, CVE-patched `onnx` 1.22.0 as `requirements.txt`: tf2onnx 1.17.0 dropped the `protobuf~=3.20` ceiling and TensorFlow 2.19.0 raised its `ml-dtypes` ceiling, so the two resolver conflicts that previously forced `onnx` down to 1.17.0 here are gone. The file records that history. |
| `requirements.txt` | The pinned validation toolchain for `validate-cpu.py` (current, CVE-patched `onnx`). |
| `PROVENANCE.md` | Upstream source, every hash, both graph contracts, the license reading and modification notice, and the measured offline results. |
| `image-credits.md` | Attribution and pinned digests for the fixture photographs. |
| `LICENSE` | Apache License 2.0, the licence of the upstream models. |

## Requirements

- Python 3.11 (the recorded run used 3.11.2 on aarch64 Linux)
- Network access to `storage.googleapis.com` (models) and
  `upload.wikimedia.org` (fixtures)
- ~2 GB of disk for the pinned TensorFlow wheel

A container would be preferable for a digest-pinned environment. Docker was not
available on the machine that produced these files, so the recipe pins exact
package versions and pins the *outputs* by SHA-256, which is what actually
protects the bytes.

## Usage

```bash
# 1. Convert. Fails loudly on any digest mismatch or custom-domain operator.
tools/models/mediapipe-hands/convert.sh /tmp/hand-conversion

# 2. Prove the graphs offline, on the CPU, with overlays to look at.
.venv/bin/python tools/models/mediapipe-hands/validate-cpu.py \
  --models /tmp/hand-conversion \
  --images apps/docs/public/hand-gate/images/*.jpg \
  --expect-two-hands two-hands-sky.jpg \
  --overlay /tmp/hand-overlays --json /tmp/hand-cpu-report.json

# 3. Stage the untracked browser gate, then open it on real hardware.
tools/models/mediapipe-hands/stage-gate.sh
# http://localhost:3006/hand-gate/index.html
```

Reusing an existing environment instead of building a new one:

```bash
tools/models/mediapipe-hands/convert.sh /tmp/hand-conversion --venv /path/to/.venv
```

## Expected results

| Artifact | Bytes | Digest |
| --- | --- | --- |
| `hand_landmarker.task` (upstream) | 7,819,105 | SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `palm-detector.onnx` | 4,589,374 | graph `a19a133771a070d26591f473695b5cbcffb1af148c7b5165162eed8aeefd6ac2` |
| `hand-landmark.onnx` | 10,903,457 | graph `416a84388303c48900c5edafc3f06d28126e0baf8772860af1c19e9d8a2052cc` |

**Upstream artifacts are pinned by SHA-256; the converted ONNX files are pinned
by a structural graph digest instead.** `tf2onnx` is not byte-reproducible: seven
conversions of the same TFLite file with the same pinned toolchain on the same
machine produced seven identically-sized files with seven different SHA-256
digests, because generated tensor names come from a process-global counter. The
operators and weights are identical every time, which is exactly what
`graph-digest.py` measures and `convert.sh` enforces. See `PROVENANCE.md`.

Contracts, both opset 18, both **float32** NHWC in and out:

- detector: `input_1` `[1,192,192,3]` → `Identity` `[1,2016,18]`, `Identity_1` `[1,2016,1]`
- landmark: `input_1` `[1,224,224,3]` → `Identity` `[1,63]` (crop pixels),
  `Identity_1` presence `[1,1]`, `Identity_2` handedness `[1,1]`,
  `Identity_3` world `[1,63]`

`validate-cpu.py` prints `PASS` with two hands on `two-hands-sky.jpg`
(presence 0.990/0.995) and one on `one-hand-rotated.jpg` (presence 0.954).

## Why there is so much Python for "just a model conversion"

Because a successful `tf2onnx` command proves only that a graph converted. The
MediaPipe hand pipeline is two neural graphs plus a substantial amount of host
arithmetic — anchors, NMS, a rotated ROI, a crop, an inverse transform, and a
tracking loopback — none of which is inside either `.onnx` file. `hand_pipeline.py`
is that arithmetic, written once, in a place where it can be checked against
real photographs before any of it is rewritten in TypeScript and WGSL.

See `PROVENANCE.md` for the full audit record, including the honest note that
the converted pair measures 14.78 MiB against the plan's 12 MiB target.
