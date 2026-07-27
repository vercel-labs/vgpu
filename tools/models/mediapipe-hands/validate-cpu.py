#!/usr/bin/env python3
"""Runs the converted palm detector + hand landmark pair on CPU and checks it.

Tooling only: never imported by the docs app, the example, or CI.

This is the offline half of the plan's phase 1. It proves, without a browser and
without a GPU, that:

  * both ONNX graphs load in onnxruntime's CPU EP with the recorded contracts,
  * the anchor decode / weighted NMS / ROI transcription in `hand_pipeline.py`
    produces plausible palms on real photographs,
  * the landmark stage, fed a rotated crop built from that ROI, returns 21
    points that land inside the crop and inside the detected palm region,
  * a two-hand photograph yields two accepted detections and two landmark sets
    with separated MCP centroids.

Failure here means the gate would fail too, and for a reason that has nothing to
do with WebGPU.

Usage:
  validate-cpu.py --models DIR --images IMG [IMG ...] [--json OUT] [--overlay DIR]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hand_pipeline as hp  # noqa: E402

DETECTOR_CONTRACT = {
    "input": ("input_1", "tensor(float)", [1, 192, 192, 3]),
    "outputs": [("Identity", [1, 2016, 18]), ("Identity_1", [1, 2016, 1])],
}
LANDMARK_CONTRACT = {
    "input": ("input_1", "tensor(float)", [1, 224, 224, 3]),
    "outputs": [("Identity", [1, 63]), ("Identity_1", [1, 1]),
                ("Identity_2", [1, 1]), ("Identity_3", [1, 63])],
}


def check_contract(sess: ort.InferenceSession, expected: dict, label: str, problems: list[str]) -> None:
    inp = sess.get_inputs()[0]
    name, dtype, shape = expected["input"]
    if inp.name != name or inp.type != dtype or list(inp.shape) != shape:
        problems.append(
            f"{label}: input is {inp.name}/{inp.type}/{inp.shape}, expected {name}/{dtype}/{shape}")
    outs = sess.get_outputs()
    if len(outs) != len(expected["outputs"]):
        problems.append(f"{label}: {len(outs)} outputs, expected {len(expected['outputs'])}")
    for got, (want_name, want_shape) in zip(outs, expected["outputs"]):
        if got.name != want_name or list(got.shape) != want_shape:
            problems.append(
                f"{label}: output {got.name}/{got.shape}, expected {want_name}/{want_shape}")
        if got.type != "tensor(float)":
            problems.append(f"{label}: output {got.name} is {got.type}, expected tensor(float)")


def expanded_box(det: hp.Detection, factor: float = 1.6) -> tuple[float, float, float, float]:
    """A tolerant box around the palm detection: landmarks reach past the palm."""
    cx, cy = (det.xmin + det.xmax) / 2, (det.ymin + det.ymax) / 2
    hw, hh = det.width * factor, det.height * factor
    return cx - hw, cy - hh, cx + hw, cy + hh


def inside(box, p) -> bool:
    return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]


def analyse(image_path: Path, det_sess, lm_sess, anchors, overlay_dir: Path | None) -> dict:
    src = np.asarray(Image.open(image_path).convert("RGB"))
    square_u8, lb = hp.letterbox_image(src, hp.DETECTOR_SIZE)
    det_in = hp.to_nhwc_float(square_u8)

    boxes, scores = det_sess.run(None, {"input_1": det_in})
    raw = hp.decode_detections(boxes, scores, anchors)
    kept = hp.weighted_nms(raw)

    record: dict = {
        "image": image_path.name,
        "source": {"width": int(src.shape[1]), "height": int(src.shape[0])},
        "letterbox": lb.as_dict(),
        "rawDetections": len(raw),
        "acceptedDetections": len(kept),
        "hands": [],
        "problems": [],
    }

    overlay = None
    if overlay_dir is not None:
        overlay = Image.fromarray(square_u8).resize((768, 768), Image.NEAREST)
        draw = ImageDraw.Draw(overlay)

    for index, det in enumerate(kept):
        roi = hp.detection_to_roi(det)
        crop = hp.crop_roi(square_u8, roi, hp.LANDMARK_SIZE)
        lm_raw, presence, handed, world = lm_sess.run(None, {"input_1": crop})
        hand = hp.decode_landmarks(lm_raw, presence, handed, roi)

        pts_crop = hand.landmarks_crop[:, :2]
        pts_sq = hand.landmarks_square[:, :2]
        in_crop = int(np.sum((pts_crop >= 0) & (pts_crop <= 1)) // 2)
        strictly_in_crop = int(np.sum(np.all((pts_crop >= 0) & (pts_crop <= 1), axis=1)))
        box = expanded_box(det)
        in_box = int(sum(inside(box, p) for p in pts_sq))
        tips_in_box = int(sum(inside(box, pts_sq[i]) for i in hp.FINGERTIP_LANDMARKS))
        centroid_sq = hand.palm_centroid_square()
        centroid_src = hp.square_to_source(lb, centroid_sq[None, :])[0]
        bones = [float(np.linalg.norm(pts_sq[a] - pts_sq[b])) for a, b in hp.HAND_BONES]
        duplicates = len(pts_sq) - len({(round(x, 6), round(y, 6)) for x, y in pts_sq})

        entry = {
            "index": index,
            "detectionScore": det.score,
            "detectionBox": [det.xmin, det.ymin, det.xmax, det.ymax],
            "roi": roi.as_dict(),
            "roiRotationDegrees": math.degrees(roi.rotation),
            "presence": hand.presence,
            "handedness": hand.handedness,
            "landmarksInCropBounds": strictly_in_crop,
            "landmarkCoordsInCropBounds": in_crop,
            "landmarksInExpandedBox": in_box,
            "fingertipsInExpandedBox": tips_in_box,
            "duplicatePoints": duplicates,
            "boneLengthMin": min(bones),
            "boneLengthMax": max(bones),
            "palmCentroidSquare": [float(centroid_sq[0]), float(centroid_sq[1])],
            "palmCentroidSource": [float(centroid_src[0]), float(centroid_src[1])],
            "landmarksSquare": [[float(x), float(y)] for x, y in pts_sq],
        }

        problems = []
        if not np.all(np.isfinite(hand.landmarks_square)):
            problems.append("non-finite landmark")
        if not (0.0 <= hand.presence <= 1.0):
            problems.append(f"presence {hand.presence} out of [0,1]")
        if strictly_in_crop < 18:
            problems.append(f"only {strictly_in_crop}/21 landmarks inside the crop")
        if in_box < 18:
            problems.append(f"only {in_box}/21 landmarks inside the expanded detection box")
        if tips_in_box < 4:
            problems.append(f"only {tips_in_box}/5 fingertips inside the expanded detection box")
        if not inside(box, centroid_sq):
            problems.append("MCP centroid outside the expanded detection box")
        if duplicates:
            problems.append(f"{duplicates} duplicate landmark positions")
        if min(bones) <= 0.0:
            problems.append("zero-length bone")
        if max(bones) > roi.size:
            problems.append(f"bone {max(bones):.4f} longer than the ROI {roi.size:.4f}")
        entry["problems"] = problems
        record["problems"] += [f"{image_path.name}[{index}]: {p}" for p in problems]
        record["hands"].append(entry)

        if overlay is not None:
            s = 768
            draw.rectangle([det.xmin * s, det.ymin * s, det.xmax * s, det.ymax * s],
                           outline=(255, 80, 80), width=3)
            m = hp.roi_matrix(roi)
            corners = [(0, 0), (1, 0), (1, 1), (0, 1)]
            poly = [((m[0, 0] * u + m[0, 1] * v + m[0, 2]) * s,
                     (m[1, 0] * u + m[1, 1] * v + m[1, 2]) * s) for u, v in corners]
            draw.polygon(poly, outline=(80, 160, 255))
            for a, b in hp.HAND_BONES:
                draw.line([pts_sq[a][0] * s, pts_sq[a][1] * s,
                           pts_sq[b][0] * s, pts_sq[b][1] * s], fill=(120, 255, 120), width=2)
            for x, y in pts_sq:
                draw.ellipse([x * s - 3, y * s - 3, x * s + 3, y * s + 3], fill=(255, 255, 0))
            draw.ellipse([centroid_sq[0] * s - 6, centroid_sq[1] * s - 6,
                          centroid_sq[0] * s + 6, centroid_sq[1] * s + 6], fill=(255, 0, 255))

    if len(record["hands"]) >= 2:
        a = np.array(record["hands"][0]["palmCentroidSquare"])
        b = np.array(record["hands"][1]["palmCentroidSquare"])
        record["centroidSeparation"] = float(np.linalg.norm(a - b))
        if record["centroidSeparation"] < 0.05:
            record["problems"].append(
                f"{image_path.name}: two hands but centroids only "
                f"{record['centroidSeparation']:.4f} apart")

    if overlay is not None:
        overlay_dir.mkdir(parents=True, exist_ok=True)
        overlay.save(overlay_dir / f"{image_path.stem}-overlay.png")
        record["overlay"] = str(overlay_dir / f"{image_path.stem}-overlay.png")

    return record


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--models", required=True, type=Path,
                    help="directory holding palm-detector.onnx and hand-landmark.onnx")
    ap.add_argument("--images", required=True, nargs="+", type=Path)
    ap.add_argument("--json", type=Path)
    ap.add_argument("--overlay", type=Path)
    ap.add_argument("--expect-two-hands", nargs="*", default=[],
                    help="file names that must yield exactly two accepted detections")
    args = ap.parse_args(argv[1:])

    det_path = args.models / "palm-detector.onnx"
    lm_path = args.models / "hand-landmark.onnx"
    problems: list[str] = []
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    det_sess = ort.InferenceSession(str(det_path), opts, providers=["CPUExecutionProvider"])
    lm_sess = ort.InferenceSession(str(lm_path), opts, providers=["CPUExecutionProvider"])
    check_contract(det_sess, DETECTOR_CONTRACT, "palm-detector", problems)
    check_contract(lm_sess, LANDMARK_CONTRACT, "hand-landmark", problems)

    anchors = hp.ssd_anchors()
    report = {
        "detector": {"path": str(det_path), "bytes": det_path.stat().st_size},
        "landmark": {"path": str(lm_path), "bytes": lm_path.stat().st_size},
        "onnxruntime": ort.__version__,
        "anchors": int(anchors.shape[0]),
        "images": [],
        "problems": problems,
    }

    for image in args.images:
        record = analyse(image, det_sess, lm_sess, anchors, args.overlay)
        report["images"].append(record)
        report["problems"] += record["problems"]
        if image.name in args.expect_two_hands and record["acceptedDetections"] != 2:
            report["problems"].append(
                f"{image.name}: {record['acceptedDetections']} accepted detections, expected 2")

    report["verdict"] = "PASS" if not report["problems"] else "FAIL"

    if args.json:
        args.json.write_text(json.dumps(report, indent=2))

    for record in report["images"]:
        print(f"{record['image']}: raw={record['rawDetections']} "
              f"kept={record['acceptedDetections']}")
        for h in record["hands"]:
            print(f"   hand[{h['index']}] score={h['detectionScore']:.3f} "
                  f"presence={h['presence']:.3f} handedness={h['handedness']:.3f} "
                  f"rot={h['roiRotationDegrees']:.1f}deg "
                  f"inCrop={h['landmarksInCropBounds']}/21 "
                  f"inBox={h['landmarksInExpandedBox']}/21 "
                  f"tips={h['fingertipsInExpandedBox']}/5 "
                  f"centroid=({h['palmCentroidSource'][0]:.0f},{h['palmCentroidSource'][1]:.0f})px")
    print()
    for p in report["problems"]:
        print(f"PROBLEM {p}")
    print(report["verdict"])
    return 0 if report["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
