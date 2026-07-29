# Depth model candidates — quality evaluation

## Why this exists

The FastDepth 160×128 gate passed on the author's Apple M4 Pro (Chrome 150) with
**0 required failures and roughly a thousand times the latency headroom it
needed**: p50 1.6 ms, p95 5.7 ms against a 5000 ms ceiling, session create
773 ms. The author's verdict on the result was nevertheless negative — the depth
maps carry too little information.

That flips the constraint set. **Latency is no longer binding** on author-class
hardware. What still binds:

| Constraint | Status |
| --- | --- |
| Payload size | **now the hard one** — see the discussion below |
| Licence / redistribution evidence | all candidates below are MIT or Apache-2.0 |
| ONNX + ORT-web WebGPU EP support | eliminated the int8 candidate outright |
| Same-origin serving, no CDN at runtime | satisfied by every candidate |
| Deterministic ORT-free thumbnails | unaffected by model choice |

## Candidates

| Candidate | Payload | Input | Output | Normalization | Semantics | Licence |
| --- | --- | --- | --- | --- | --- | --- |
| `fastdepth-160x128` | 5,420,430 B (5.17 MiB) | `input.1` f32 [1,3,128,160] | `424` [1,1,128,160] | `rgb/255` | metric m | MIT |
| `fastdepth-224x224` | 5,420,430 B (5.17 MiB) | `input.1` f32 [1,3,224,224] | `424` [1,1,224,224] | `rgb/255` | metric m | MIT |
| `fastdepth-320x256` | 5,420,454 B (5.17 MiB) | `input.1` f32 [1,3,256,320] | `424` [1,1,256,320] | `rgb/255` | metric m | MIT |
| `midas-v21-small-256` | 66,764,249 B (63.7 MiB) | `0` f32 [1,3,256,256] | `797` [1,256,256] | `rgb/255` ¹ | inverse, relative | MIT |
| `dav2-small` | 99,060,839 B (94.5 MiB) | `pixel_values` f32 [b,3,h,w] | `predicted_depth` [1,h,w] | ImageNet | inverse, relative | Apache-2.0 |

¹ **MiDaS bakes its own ImageNet normalization into the graph** — the first two
nodes on input `0` are `Sub` [0.485, 0.456, 0.406] and `Div` [0.229, 0.224,
0.225]. It must be fed plain `rgb/255`; normalizing beforehand double-applies it
and silently degrades the output.

SHA-256 (verified after download, re-verified by `acquire-candidates.sh --check`):

```text
6cd8060e86d8b92620f49a3687c224565b6b1dd3e7786e396d9c0bdd05310155  fastdepth-160x128.onnx
7a9f571d9496555bbcc9c46dcb77f1357fb84d3f2608cd38af91fe66c96dfe85  fastdepth-224x224.onnx
dfc532a08f0ee34283d890d845e3824973f17240ad1d7eb617d9959ec8dc23c9  fastdepth-320x256.onnx
2d8c6cb8f415229daf1eb041024208e2608c9f98e17c81cc7c6ecb449c56fd58  midas-v21-small-256.onnx
afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c  dav2-small.onnx
```

Sources: FastDepth exports come from the same audited PINTO archive as the
incumbent (see `../fastdepth/PROVENANCE.md`); MiDaS from the `isl-org/MiDaS`
`v2_1` release asset `model-small.onnx`; Depth Anything V2 Small from
`onnx-community/depth-anything-v2-small` (`onnx/model.onnx`), an ONNX export of
`depth-anything/Depth-Anything-V2-Small`.

**All three FastDepth entries are the same 5.4 MB weight set.** The PINTO archive
ships one pruned checkpoint exported at eight fixed resolutions, so moving from
160×128 to 224×224 or 320×256 costs nothing in payload — only inference time,
which is no longer scarce.

## Rejected: int8 quantization

`onnx-community/depth-anything-v2-small` also publishes `model_int8.onnx`
(27,258,801 B, 26.0 MiB), which looked like the way to fit a modern model into
the payload budget. It is not usable here:

```text
onnxruntime.capi.onnxruntime_pybind11_state.NotImplemented:
  [ONNXRuntimeError] : 9 : NOT_IMPLEMENTED : Could not find an implementation for
  ConvInteger(10) node with name '/patch_embed/proj/Conv_quant'
```

The int8 export is built from `DynamicQuantizeLinear` (79), `MatMulInteger` (48)
and `ConvInteger` (31). Those integer ops are not implemented by the ORT **WebGPU**
EP, so even where a CPU implementation exists the graph would be dragged back to
the CPU — which the gate deliberately fails, since the whole point of the example
is a GPU-resident output. Quantization is the wrong size lever for WebGPU; fp16
(47.3 MiB) or 4-bit `MatMulNBits` (`model_q4f16`, 18.2 MiB) are the WebGPU-shaped
options, and both remain above the payload budget anyway.

## Local CPU-EP validation

`validate-multi.py` runs every candidate on both room fixtures through the ONNX
Runtime CPU EP and checks shapes, finiteness, spread and layering, then writes
previews. All five candidates passed; full reports live beside the tool when run.

Detail metrics are computed on a **canonical 320×256 grid**, because per-pixel
gradient energy shrinks as output resolution grows — measuring natively would
have ranked the coarsest model "most detailed", which is exactly backwards.

| Candidate | canonical grad | canonical Laplacian var | edge alignment ² |
| --- | --- | --- | --- |
| `fastdepth-160x128` | 0.00412 / 0.00363 | 0.000083 / 0.000069 | 0.140 / 0.054 |
| `fastdepth-224x224` | 0.00458 / 0.00428 | 0.000226 / 0.000126 | 0.131 / 0.087 |
| `fastdepth-320x256` | 0.00442 / 0.00413 | 0.000645 / 0.000378 | 0.091 / 0.059 |
| `midas-v21-small-256` | 0.00376 / 0.00379 | 0.000125 / 0.000129 | 0.077 / 0.078 |
| `dav2-small` (560×448) | 0.00338 / 0.00421 | 0.000252 / 0.000592 | **0.250 / 0.224** |

² Pearson correlation between depth-gradient magnitude and image-luma-gradient
magnitude — "do the depth edges land on real object boundaries".

**Read this table with suspicion.** Edge alignment ranks MiDaS *below* the
incumbent, which the previews flatly contradict: MiDaS produces clean,
piecewise-planar surfaces with correct discontinuities, while FastDepth produces
a blob. The metric rewards following luma texture (carpet weave, wood grain),
which a good depth model should ignore. It is reported because it is the one
number that clearly separates Depth Anything from the field, not because it
settles the MiDaS-vs-FastDepth question. The previews settle that.

## Advisory quality ranking (the author decides)

From the CPU previews on both fixtures:

1. **Depth Anything V2-S** — resolves individual objects: the coffee table and
   cups, the hanging lamp, the bed frame, the doorway through to the next room.
   The only candidate that looks like it understands the scene.
2. **MiDaS v2.1 small** — a large jump over FastDepth: correct walls, floor
   gradient, door and window openings, furniture separated from the floor.
   Smooth rather than detailed.
3. **FastDepth 320×256** ≈ **224×224** — smoother than the incumbent and cheap,
   but still fundamentally a blob; more output pixels do not add information
   that the pruned network never computed.
5. **FastDepth 160×128** — the incumbent the author rejected.

## Payload discussion — flagged, not decided

Nothing that meaningfully improves quality fits the current budget: the smallest
quality jump (MiDaS) is 63.7 MiB, seven times the ≤9 MiB preference and four
times the ≤16 MiB exception.

Relevant precedent already in this repository:

- the largest **tracked** binary at the time of this decision was
  `apps/docs/public/models/movenet/movenet-lightning.onnx` at 9,402,989 B
  (8.97 MiB), sitting right on the ≤9 MiB line; that MoveNet model has since
  been removed, so the precedent is historical rather than current;
- `apps/docs/public/ort/` is **gitignored** (`apps/docs/.gitignore: public/ort`)
  and staged at build time by `apps/docs/scripts/prepare-ort-assets.mjs` — the
  24,254,953 B (23.1 MiB) ORT asyncify wasm already ships to users this way
  without ever entering git history.

So the choice is not "check in 64 MiB or give up". Options, in rough order of how
much they disturb the existing conventions:

1. keep FastDepth at a higher resolution — free, but does not address the
   complaint;
2. extend the existing gitignored-and-staged pattern from `/ort/` to `/models/`,
   fetching the model from its verified upstream at build time;
3. fetch at runtime from a same-origin path populated by that build step;
4. take an explicit payload exception and track the model.

Option 2 reuses machinery the repo already trusts, but it makes the docs build
depend on a 64–95 MiB download, and it changes the offline story. That is a
project-level call, not one to make from inside this task.

## Reproducing

```bash
tools/models/depth-candidates/acquire-candidates.sh          # download + verify + stage
tools/models/depth-candidates/acquire-candidates.sh --check  # verify a staged set offline

python3 -m venv .venv && .venv/bin/pip install -r tools/models/depth-candidates/requirements.txt
.venv/bin/python tools/models/depth-candidates/validate-multi.py \
  dav2-small-560x448 apps/docs/public/depth-gate/models/dav2-small.onnx \
  apps/docs/public/depth-gate/images/room-a.jpg apps/docs/public/depth-gate/images/room-b.jpg
```

Then judge by eye on a real GPU — the comparison harness runs every staged
candidate under the same WebGPU contract and puts the previews side by side:

```text
http://localhost:3000/depth-gate/compare.html
```
