# mnist-12.onnx provenance

This directory holds a redistributed copy of the ONNX Model Zoo MNIST classifier
used by the `mnist-classifier` docs example. It is served same-origin so the
example performs no third-party download at runtime.

## Upstream source

| Field | Value |
| --- | --- |
| Repository | https://github.com/onnx/models |
| Immutable commit | `4c46cd00fbdb7cd30b6c1c17ab54f2e1f4f7b177` (2023-12-22) |
| Path | `validated/vision/classification/mnist/model/mnist-12.onnx` |
| Model card | `validated/vision/classification/mnist/README.md` at the same commit |
| Retrieved | 2026-07-27 via `https://media.githubusercontent.com/media/onnx/models/main/validated/vision/classification/mnist/model/mnist-12.onnx` (Git LFS object, not the pointer file) |

## Verified bytes

| Field | Value |
| --- | --- |
| Size | 26,143 bytes |
| SHA-256 | `5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd` |

Both values match the Git LFS pointer recorded upstream. `sha256sums` in this
directory is the checked-in digest; verify with `sha256sum -c sha256sums`.

## Model contract

| Field | Value |
| --- | --- |
| Producer | CNTK |
| ONNX IR version | 7 (ONNX 1.9), opset 12 |
| Input | `Input3`, float32, `[1, 1, 28, 28]`, values in `[0, 1]` |
| Output | `Plus214_Output_0`, float32, `[1, 10]`, **pre-softmax logits** |
| Operators | `Add`, `Conv`, `MatMul`, `MaxPool`, `Relu`, `Reshape` |
| Reported accuracy | 1.1% top-1 error (upstream model card) |

Architecture: alternating convolution and max-pooling layers, trained on the
MNIST dataset following the CNTK 103D tutorial referenced by the model card.

## Licensing

The model-specific card at the pinned commit declares MIT twice:

- line 1: `<!--- SPDX-License-Identifier: MIT -->`
- the `## License` section: `MIT`

The `LICENSE` file beside this note reproduces the MIT terms that therefore
apply to this artifact. Note that the repository root of `onnx/models` is
Apache-2.0 while this model directory is MIT; both permit redistribution, and
this copy keeps the model-specific MIT notice so attribution stays accurate.

> Open item for maintainers: the upstream MIT notice carries no copyright
> holder line, so the notice below attributes it to the ONNX Model Zoo
> contributors. Confirm this attribution wording before publishing.

## Files

| File | Purpose |
| --- | --- |
| `mnist-12.onnx` | the redistributed model |
| `LICENSE` | MIT notice that applies to the model |
| `sha256sums` | checked-in digest of the model |
| `provenance.md` | this record |

The examples source API (`apps/docs/lib/examples-api`) is UTF-8 text only, so
this binary is deliberately absent from `meta.files` and from anything
`vgpu examples pull` produces. The example documents that limitation.
