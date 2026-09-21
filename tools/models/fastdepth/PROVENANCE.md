# fast_depth_128x160.onnx provenance

Audit record for the depth-estimation example's candidate model: the **final
pruned FastDepth** network (MobileNet encoder + NNConv5 depthwise decoder with
skip-adds) exported at a fixed **160×128** input.

`tools/models/fastdepth/acquire.sh` copies this file next to the model whenever
it stages `apps/docs/public/models/fastdepth/`, so the record ships with the
bytes it describes.

## Verified bytes

| Field | Value |
| --- | --- |
| File | `fastdepth-160x128.onnx` (upstream name `fast_depth_128x160.onnx`) |
| Size | 5,420,430 bytes (5.17 MiB) |
| SHA-256 | `6cd8060e86d8b92620f49a3687c224565b6b1dd3e7786e396d9c0bdd05310155` |
| Upstream mtime inside the archive | 2021-09-11 12:17 UTC |

5.17 MiB is inside the plan's preferred ≤9 MiB budget, so neither the float16
variant nor the ≤16 MiB exception is needed.

## Upstream lineage

Two layers of provenance apply: the trained weights and the ONNX export.

### 1. Weights — `dwofk/fast-depth` (MIT)

| Field | Value |
| --- | --- |
| Repository | https://github.com/dwofk/fast-depth |
| Immutable commit | `e68492011609c9bfb7de6d402da5d1d201d95bd9` (2020-07-31, latest on `master`) |
| License | MIT, `Copyright (c) 2019 Diana Wofk` — SHA-256 of the LICENSE blob at that commit: `67d1622876eb6b7c904d2f21280289cf63a474ac979a4a712043b445df874136` |
| Paper | *FastDepth: Fast Monocular Depth Estimation on Embedded Systems* (arXiv:1903.03273) |
| Checkpoint | `mobilenet-nnconv5dw-skipadd-pruned` — the repository's final pruned model, reported at 0.37 GMAC at 224×224 |
| Training data | NYU Depth v2 (indoor, metric depth in metres) |

The upstream weight host `http://datasets.lids.mit.edu/fastdepth/results/` did
**not respond** while this record was written (TCP connect timeout), which is
why the audited pre-export below is used instead of a from-checkpoint export.

### 2. ONNX export — `PINTO0309/PINTO_model_zoo` #146 (MIT)

| Field | Value |
| --- | --- |
| Directory | https://github.com/PINTO0309/PINTO_model_zoo/tree/main/146_FastDepth |
| Last commit touching it | `c6abe1a21c95771462c72bbfa700e837fa13cf73` (2023-03-14, "Google Drive to Wasabi Storage") |
| License file in that directory | MIT, `Copyright (c) 2019 Diana Wofk` — i.e. the directory re-states the upstream FastDepth notice, it does not add a separate one |
| Attribution recorded upstream (`url.txt`) | `https://github.com/dwofk/fast-depth`, `https://github.com/PINTO0309/openvino2tensorflow` |
| Aggregate archive | `https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/146_FastDepth/resources.tar.gz` |
| Archive size | 724,201,074 bytes, `Last-Modified: Tue, 14 Mar 2023 15:00:23 GMT` |
| Archive SHA-256 | `f708a5bf9e405cacce565081a811a9edf5cd4bcde1f5cb0e7ab097662a97ef13` |
| Member extracted | `saved_model_128x160/fast_depth_128x160.onnx` (only this one member) |

The 724 MB archive is **never committed**; `acquire.sh` downloads it to a
scratch directory, verifies its digest, extracts exactly one member, verifies
that member's digest, and stages only the ONNX file.

#### Lineage audit of the export

The graph is a direct PyTorch export, not a round-tripped TensorFlow artifact:

- `producer_name: pytorch`, `producer_version: 1.9`, IR version 6, opset 11.
- Layout is **NCHW** with `Conv`/`Resize` nodes — an `openvino2tensorflow`
  round trip would have produced NHWC `Transpose`-heavy graphs like the sibling
  `saved_model*`/`tflite`/`tfjs` outputs in the same archive.
- `146_FastDepth/convert_script.txt` at the pinned commit confirms the
  direction: it starts from `fast_depth_${H}x${W}.onnx`, runs `onnxsim` on it,
  and only then feeds OpenVINO's `mo.py` and `openvino2tensorflow`. The ONNX is
  the *input* to that pipeline, so it inherits only the PyTorch export plus
  `onnx-simplifier`.

Residual audit gap, stated plainly: the exact `torch.onnx.export` invocation and
the exact `onnxsim` version are **not** published upstream, so the export is
reproducible only in the sense that the *bytes* are pinned and verified by hash,
not that they can be regenerated bit-for-bit. Numerical behaviour was instead
verified directly (below), and the redistribution right comes from MIT.

## Graph contract (verified with `onnx` 1.17.0, `onnx.checker` clean)

| Field | Value |
| --- | --- |
| IR version / opset | 6 / 11 (default domain only) |
| Producer | `pytorch` 1.9 |
| Input | `input.1`, float32, `[1, 3, 128, 160]` (NCHW, fixed) |
| Output | `424`, float32, `[1, 1, 128, 160]` (row-major, 20,480 scalars, 81,920 bytes) |
| Nodes | 84 — `Conv` ×38, `Clip` ×27, `Relu` ×11, `Resize` ×5, `Add` ×3 |
| Initializers | 80 tensors, 5,408,924 raw bytes |
| Dynamic axes | none |

There is no `Softmax`/`Sigmoid`/`Exp` tail: the network emits raw depth.

## Semantics and normalization (measured, not assumed)

Both were determined from upstream source **and** by running the graph on the CPU
EP with `tools/models/fastdepth/validate-cpu.py`.

Upstream evidence (`dataloaders/dataloader.py` at the pinned commit,
`__getitem__`): the colour-normalization calls are commented out, and the tensor
is produced by `transforms.ToTensor()` alone, which only scales to `[0, 1]`:

```python
# color normalization
# rgb_tensor = normalize_rgb(rgb_tensor)
# rgb_np = normalize_np(rgb_np)
...
to_tensor = transforms.ToTensor()
input_tensor = to_tensor(input_np)
```

So the model was trained on plain `rgb/255`. Measured confirmation, CPU EP:

| Candidate normalization | room-a (living room) | room-b (bedroom) | Verdict |
| --- | --- | --- | --- |
| `rgb/255` | min 1.44, p50 5.86, max 7.31, 100% positive, near probe 2.31 m vs far band 6.40 m | min 1.31, p50 4.39, max 7.75, 100% positive, near probe 1.45 m vs far band 6.26 m | **locked** |
| ImageNet mean/std | max 10.92 — outside the NYU 10 m training range | p50 2.60 vs 4.39, i.e. the whole scene is pulled ~1.8 m nearer | rejected |

A third, later-rejected fixture (the monochrome 1920s archival photo in
`image-credits.md`) made the gap starkest: `rgb/255` already clamped 10% of its
pixels to 0 m because the scene is out of domain, and ImageNet normalization
pushed that to 39% with the mean collapsing to 0.83 m. That image was dropped
from the gate for exactly this reason; it is not evidence about the two
fixtures that ship.

Locked contract:

- Preprocessing: centre-crop to 5:4 ("cover"), resize to 160×128, `rgb/255`,
  NCHW with `index = c*H*W + y*W + x`. **No** ImageNet mean/std.
- Output semantics: **metric depth in metres**, NYU Depth v2 indoor domain —
  *not* inverse or relative depth. Larger value = farther away.
- Region probes confirm the sign: in both fixtures the near furniture/floor band
  reads 1.4–2.3 m while the far wall/window band reads 5.6–6.4 m.
- The plan's shader normalization therefore applies unchanged:
  `near = 1 - clamp(log(max(d, 0.35)/0.35) / log(10/0.35), 0, 1)`.

Observation for the visual phase: measured values occupy roughly 1.3–7.7 m, so
over the fixed `[0.35 m, 10 m]` log range `near` only spans about `[0.07, 0.55]`.
The relief shader may need to expand contrast (or the range may want tightening
to something like `[1 m, 8 m]`) — that is a Phase 3 decision, and changing it
requires updating this record and
`apps/docs/examples/depth-estimation/renderer.ts` together.

## Real-GPU gate result

The blocking gate lives at `/depth-gate/index.html` (untracked payload, see
`tools/models/fastdepth/README.md`). Local evidence on this host, which only has
software WebGPU, is recorded for completeness — the author still owns the real-GPU
sign-off required by the plan:

| Field | Value |
| --- | --- |
| Date | 2026-07-27 |
| Browser | Chrome (agent-browser 0.33.0, `--webgpu --headed`), ORT 1.27.0 |
| Adapter | `vendor: google`, `architecture: swiftshader` (software Vulkan) |
| Verdict | `DEPTH_GATE_PASS`, 22 checks, 0 required failures, 1 advisory warning |
| Output | every run `location: 'gpu-buffer'`, float32 `[1,1,128,160]`, buffer 131,072 bytes (≥ the contracted 81,920) |
| Values | 100% finite and positive on both fixtures; room-a mean 5.07 m / std 1.67; room-b mean 3.85 m / std 1.69 |
| Latency | session create ~1.3 s; first (warmup) run ~32 s of shader compilation, then p50 ≈ 7 ms, p95 ≈ 52 ms on SwiftShader |
| Advisory | room-b mean differs from the CPU reference by 0.65 m (Canvas2D resize vs Lanczos on a detailed scene); room-a matched within 0.10 m |

Software-WebGPU numbers say nothing about real-GPU latency, but they do prove the
graph is fully supported by ORT's WebGPU EP with no CPU fallback and no operator
gaps.

## Fixture images

See `tools/models/fastdepth/image-credits.md`.

## Files staged next to the model

| File | Purpose |
| --- | --- |
| `fastdepth-160x128.onnx` | the redistributed model |
| `LICENSE` | MIT notice that applies to the model |
| `SHA256SUMS` | checked-in digest of the model |
| `PROVENANCE.md` | this record |

The examples source API is UTF-8 text only, so the model is deliberately absent
from `meta.files`.
