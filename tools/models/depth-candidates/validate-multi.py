#!/usr/bin/env python3
"""Generic CPU-EP validator + quality profiler for depth-model candidates.

Usage:
    validate_multi.py SPEC_KEY MODEL.onnx IMAGE [IMAGE...]

Emits a JSON report per (model, image) and writes normalized preview PNGs so a
human can rank quality by eye. Also computes detail proxies (Laplacian
variance, gradient energy, distinct levels) because the author's complaint is
specifically about missing detail, not about correctness.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# key -> (width, height, normalization, semantics)
#   normalization: 'rgb255' | 'imagenet'
#   semantics:     'metric'  (bigger = farther, metres)
#                  'inverse' (bigger = nearer, relative/unitless)
SPECS = {
    'fastdepth-160x128': (160, 128, 'rgb255', 'metric'),
    'fastdepth-224x224': (224, 224, 'rgb255', 'metric'),
    'fastdepth-320x256': (320, 256, 'rgb255', 'metric'),
    # MiDaS v2.1 small bakes the ImageNet Sub/Div into the graph (first two
    # nodes on input '0'), so it must be fed plain rgb/255 or it double-normalizes.
    'midas-v21-small-256': (256, 256, 'rgb255', 'inverse'),
    'dav2-small-518': (518, 518, 'imagenet', 'inverse'),
    'dav2-small-392': (392, 392, 'imagenet', 'inverse'),
    'dav2-small-266': (266, 266, 'imagenet', 'inverse'),
    # 560x448 is exactly 5:4 and both sides are multiples of 14, so DAv2 gets an
    # aspect-correct crop identical in framing to the other candidates.
    'dav2-small-560x448': (560, 448, 'imagenet', 'inverse'),
}


def graph_report(path: str) -> dict:
    m = onnx.load(path)
    g = m.graph

    def io(vals):
        out = []
        for v in vals:
            dims = []
            for d in v.type.tensor_type.shape.dim:
                dims.append(d.dim_value if d.HasField('dim_value') else (d.dim_param or '?'))
            out.append(
                {
                    'name': v.name,
                    'dtype': onnx.TensorProto.DataType.Name(v.type.tensor_type.elem_type),
                    'dims': dims,
                }
            )
        return out

    ops: dict[str, int] = {}
    for n in g.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    return {
        'ir_version': m.ir_version,
        'producer': f'{m.producer_name} {m.producer_version}'.strip(),
        'opsets': [[i.domain, i.version] for i in m.opset_import],
        'inputs': io(g.input),
        'outputs': io(g.output),
        'node_count': len(g.node),
        'distinct_ops': len(ops),
        'ops': dict(sorted(ops.items(), key=lambda kv: -kv[1])),
    }


def preprocess(path: str, w: int, h: int, norm: str) -> tuple[np.ndarray, Image.Image]:
    """Centre-crop to the model aspect, resize, normalize. Deterministic."""
    img = Image.open(path).convert('RGB')
    target = w / h
    ratio = img.width / img.height
    sw, sh = img.width, img.height
    if ratio > target:
        sw = round(sh * target)
    else:
        sh = round(sw / target)
    left = (img.width - sw) // 2
    top = (img.height - sh) // 2
    crop = img.crop((left, top, left + sw, top + sh)).resize((w, h), Image.LANCZOS)

    arr = np.asarray(crop, dtype=np.float32) / 255.0
    if norm == 'imagenet':
        arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    chw = np.transpose(arr, (2, 0, 1))[None, ...].astype(np.float32)
    return chw, crop


def to_map(raw: np.ndarray) -> np.ndarray:
    """Squeeze a depth output of rank 2/3/4 down to (H, W)."""
    a = np.asarray(raw, dtype=np.float32)
    while a.ndim > 2:
        if a.shape[0] != 1:
            raise SystemExit(f'unexpected non-unit leading dim in output shape {a.shape}')
        a = a[0]
    if a.ndim != 2:
        raise SystemExit(f'cannot reduce output shape {raw.shape} to a 2-D map')
    return a


CANON_W, CANON_H = 320, 256


def _canon(norm: np.ndarray) -> np.ndarray:
    """Resample a 0..1 depth map onto the canonical grid.

    Per-pixel gradient/Laplacian energy shrinks as output resolution grows, so
    raw values are meaningless across models of different sizes. Comparing on a
    fixed grid makes 'how much structure is actually there' comparable.
    """
    # No explicit mode=: Pillow infers 'I;16' from a 2-D uint16 array. Passing
    # mode= to reinterpret dtype is deprecated in Pillow 12 and removed in 13.
    im = Image.fromarray((np.clip(norm, 0, 1) * 65535).astype(np.uint16))
    return np.asarray(im.resize((CANON_W, CANON_H), Image.BILINEAR), dtype=np.float32) / 65535.0


def _detail(norm: np.ndarray) -> dict:
    gx = np.abs(np.diff(norm, axis=1)).mean()
    gy = np.abs(np.diff(norm, axis=0)).mean()
    lap = (-4.0 * norm[1:-1, 1:-1] + norm[:-2, 1:-1] + norm[2:, 1:-1]
           + norm[1:-1, :-2] + norm[1:-1, 2:])
    return {'gradEnergy': round(float((gx + gy) / 2), 6),
            'lapVariance': round(float(lap.var()), 6)}


def _edge_alignment(norm: np.ndarray, crop: Image.Image) -> float:
    """Pearson correlation of |grad depth| with |grad luma| on the canonical grid.

    This is the closest proxy to the author's complaint: a depth map that is
    'low information' has edges that do not follow the actual objects.
    """
    luma = np.asarray(crop.convert('L').resize((CANON_W, CANON_H), Image.BILINEAR), dtype=np.float32) / 255.0
    def mag(a):
        gx = np.zeros_like(a); gy = np.zeros_like(a)
        gx[:, 1:] = np.abs(np.diff(a, axis=1)); gy[1:, :] = np.abs(np.diff(a, axis=0))
        return np.sqrt(gx * gx + gy * gy)
    a, b = mag(norm).ravel(), mag(luma).ravel()
    a = a - a.mean(); b = b - b.mean()
    denom = float(np.sqrt((a * a).sum()) * np.sqrt((b * b).sum()))
    return round(float((a * b).sum() / denom) if denom > 1e-12 else 0.0, 4)


def stats(depth: np.ndarray, semantics: str, crop: Image.Image | None = None) -> dict:
    finite = np.isfinite(depth)
    d = depth[finite]
    # Robust normalization to 0..1 with white = near, so detail metrics are
    # comparable across metric and inverse-depth models at different scales.
    lo, hi = np.percentile(d, 2), np.percentile(d, 98)
    norm = np.clip((depth - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    if semantics == 'metric':
        norm = 1.0 - norm

    gx = np.abs(np.diff(norm, axis=1)).mean()
    gy = np.abs(np.diff(norm, axis=0)).mean()
    lap = (
        -4.0 * norm[1:-1, 1:-1]
        + norm[:-2, 1:-1]
        + norm[2:, 1:-1]
        + norm[1:-1, :-2]
        + norm[1:-1, 2:]
    )
    canon = _canon(norm)
    return {
        'shape': list(depth.shape),
        'pixels': int(depth.size),
        'finiteRatio': round(float(finite.mean()), 6),
        'min': round(float(d.min()), 4),
        'max': round(float(d.max()), 4),
        'mean': round(float(d.mean()), 4),
        'std': round(float(d.std()), 4),
        'p05': round(float(np.percentile(d, 5)), 4),
        'p50': round(float(np.percentile(d, 50)), 4),
        'p95': round(float(np.percentile(d, 95)), 4),
        # native-resolution detail (NOT comparable across models — kept for reference)
        'native': _detail(norm),
        # canonical-grid detail (comparable across models) + edge agreement
        'canon': _detail(canon),
        'edgeAlignment': _edge_alignment(canon, crop) if crop is not None else None,
        'distinctLevels': int(np.unique(np.round(norm * 255).astype(np.uint8)).size),
    }


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        print('spec keys:', ', '.join(SPECS))
        return 2
    key, model_path = sys.argv[1], sys.argv[2]
    images = sys.argv[3:]
    if key not in SPECS:
        print(f'unknown spec key {key!r}; known: {", ".join(SPECS)}')
        return 2
    w, h, norm, semantics = SPECS[key]

    report: dict = {
        'key': key,
        'model': model_path,
        'spec': {'width': w, 'height': h, 'normalization': norm, 'semantics': semantics},
        'graph': graph_report(model_path),
        'images': [],
        'failures': [],
    }

    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    report['io'] = {'input': in_name, 'output': out_name}

    for path in images:
        chw, crop = preprocess(path, w, h, norm)
        raw = sess.run([out_name], {in_name: chw})[0]
        depth = to_map(raw)
        st = stats(depth, semantics, crop)
        st['image'] = path
        report['images'].append(st)

        if st['finiteRatio'] < 0.999:
            report['failures'].append(f'{path}: non-finite output values')
        if st['max'] - st['min'] <= 1e-6:
            report['failures'].append(f'{path}: output is constant (no depth information)')

        # Preview: white = near for every model, so previews are comparable.
        lo, hi = np.percentile(depth, 2), np.percentile(depth, 98)
        vis = np.clip((depth - lo) / max(hi - lo, 1e-6), 0, 1)
        if semantics == 'metric':
            vis = 1.0 - vis
        stem = f'{key}.{path.rsplit("/", 1)[-1].rsplit(".", 1)[0]}'
        Image.fromarray((vis * 255).astype(np.uint8)).save(f'previews/{stem}.depth.png')
        crop.save(f'previews/{stem}.input.png')

    report['status'] = 'PASS' if not report['failures'] else 'FAIL'
    print(json.dumps(report, indent=2))
    return 0 if not report['failures'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
