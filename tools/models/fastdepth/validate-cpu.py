"""CPU-EP validation of the FastDepth 160x128 candidate.

This is the offline half of the model gate: it establishes, on the CPU execution
provider, what the browser gate then has to reproduce on WebGPU.

It checks:
  * graph contract: one float32 input [1,3,128,160], one float32 output [1,1,128,160]
  * which normalization the checkpoint actually expects (rgb/255 vs ImageNet mean/std)
  * value semantics: finite, positive, metric-looking depth with meaningful spread
  * layering: the near probe (lower centre) must read closer than the far band (upper rows)
  * writes `<image>.depth.png` previews so a human can eyeball the result

Numbers printed here are pasted into `browser.js` as `CPU_REFERENCE` and into
`PROVENANCE.md`.

Usage:
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python validate-cpu.py MODEL.onnx IMAGE [IMAGE...]
"""

import json
import sys

import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image

WIDTH, HEIGHT = 160, 128
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def graph_report(path: str) -> dict:
    """Structural audit, mirrored in PROVENANCE.md."""
    import collections

    model = onnx.load(path)
    onnx.checker.check_model(model)

    def value_info(x):
        t = x.type.tensor_type
        return {
            "name": x.name,
            "dtype": onnx.TensorProto.DataType.Name(t.elem_type),
            "dims": [d.dim_value if d.HasField("dim_value") else d.dim_param for d in t.shape.dim],
        }

    return {
        "irVersion": model.ir_version,
        "producer": f"{model.producer_name} {model.producer_version}",
        "opsets": [(o.domain, o.version) for o in model.opset_import],
        "inputs": [value_info(x) for x in model.graph.input],
        "outputs": [value_info(x) for x in model.graph.output],
        "ops": dict(sorted(collections.Counter(n.op_type for n in model.graph.node).items())),
        "nodeCount": len(model.graph.node),
        "initializerCount": len(model.graph.initializer),
    }


def center_crop_resize(path: str) -> np.ndarray:
    """The production transform: centre-crop to 5:4 ("cover"), resize to 160x128, /255."""
    img = Image.open(path).convert("RGB")
    w, h = img.size
    target = WIDTH / HEIGHT  # 1.25
    if w / h > target:
        cw = int(round(h * target))
        box = ((w - cw) // 2, 0, (w - cw) // 2 + cw, h)
    else:
        ch = int(round(w / target))
        box = (0, (h - ch) // 2, w, (h - ch) // 2 + ch)
    resized = img.resize((WIDTH, HEIGHT), Image.LANCZOS, box=box)
    return np.asarray(resized, dtype=np.float32) / 255.0


def to_nchw(rgb01: np.ndarray, imagenet: bool) -> np.ndarray:
    x = (rgb01 - IMAGENET_MEAN) / IMAGENET_STD if imagenet else rgb01
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)


def stats(depth: np.ndarray) -> dict:
    flat = depth.reshape(-1)
    finite_mask = np.isfinite(flat)
    finite = flat[finite_mask]
    gx = np.abs(np.diff(depth, axis=1)).mean()
    gy = np.abs(np.diff(depth, axis=0)).mean()
    return {
        "finiteRatio": float(finite_mask.mean()),
        "positiveRatio": float((finite > 0).mean()),
        "min": float(finite.min()),
        "max": float(finite.max()),
        "mean": float(finite.mean()),
        "std": float(finite.std()),
        "p05": float(np.percentile(finite, 5)),
        "p50": float(np.percentile(finite, 50)),
        "p95": float(np.percentile(finite, 95)),
        "meanNeighborGradient": float((gx + gy) / 2),
        # Layering probes: lower centre is normally the nearest furniture/floor,
        # the upper band is normally the far wall or window.
        "nearProbeMean": float(depth[HEIGHT - 24 : HEIGHT, WIDTH // 2 - 24 : WIDTH // 2 + 24].mean()),
        "farBandMean": float(depth[8:40, :].mean()),
    }


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    model_path, image_paths = sys.argv[1], sys.argv[2:]

    report = {"model": model_path, "graph": graph_report(model_path), "images": []}

    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    (inp,) = session.get_inputs()
    (out,) = session.get_outputs()
    assert inp.shape == [1, 3, HEIGHT, WIDTH], f"unexpected input shape {inp.shape}"
    assert out.shape == [1, 1, HEIGHT, WIDTH], f"unexpected output shape {out.shape}"
    assert inp.type == "tensor(float)" and out.type == "tensor(float)"
    report["contract"] = {"inputName": inp.name, "outputName": out.name}

    failures = []
    for path in image_paths:
        rgb = center_crop_resize(path)
        entry = {"path": path}
        for label, imagenet in (("rgb_over_255", False), ("imagenet_mean_std", True)):
            y = session.run([out.name], {inp.name: to_nchw(rgb, imagenet)})[0]
            assert y.shape == (1, 1, HEIGHT, WIDTH) and y.dtype == np.float32
            depth = y[0, 0]
            entry[label] = stats(depth)
            if not imagenet:
                lo, hi = np.percentile(depth, 2), np.percentile(depth, 98)
                preview = np.clip((depth - lo) / max(hi - lo, 1e-6), 0, 1)
                Image.fromarray((preview * 255).astype(np.uint8)).resize(
                    (WIDTH * 3, HEIGHT * 3), Image.NEAREST
                ).save(path.rsplit(".", 1)[0] + ".depth.png")

        locked = entry["rgb_over_255"]
        if locked["finiteRatio"] < 0.999 or locked["positiveRatio"] < 0.999:
            failures.append(f"{path}: not finite/positive enough under rgb/255")
        if locked["p95"] - locked["p05"] < 0.5:
            failures.append(f"{path}: depth spread under rgb/255 is degenerate")
        if locked["farBandMean"] <= locked["nearProbeMean"]:
            failures.append(f"{path}: far band does not read farther than the near probe")
        report["images"].append(entry)

    report["failures"] = failures
    print(json.dumps(report, indent=2))
    if failures:
        print(f"\nFAIL: {len(failures)} check(s) failed", file=sys.stderr)
        return 1
    print("\nPASS: rgb/255 yields finite, positive, layered metric depth on every image")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
