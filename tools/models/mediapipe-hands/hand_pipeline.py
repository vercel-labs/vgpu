#!/usr/bin/env python3
"""Pure-Python reference for the host half of the MediaPipe hand pipeline.

Tooling only: never imported by the docs app, the example, or CI. It exists so
that the two converted neural graphs can be validated end to end on the CPU, and
so that the browser gate (`apps/docs/public/hand-gate/`) has an authoritative
reference to be checked against.

The two ONNX graphs contain no anchor decoding, no NMS, no ROI construction and
no cropping. All of that is host work, transcribed here from the MediaPipe
calculator options that ship alongside the same `hand_landmarker.task`:

  * `SsdAnchorsCalculatorOptions` for the 192x192 palm detector (2016 anchors),
  * `TensorsToDetectionsCalculatorOptions` (reverse_output_order, 7 keypoints),
  * `NonMaxSuppressionCalculator` in weighted mode,
  * `DetectionsToRectsCalculator` (rotation from keypoint 0 -> keypoint 2),
  * `RectTransformationCalculator` (scale 2.6, shift_y -0.5, square_long).

Everything works in the *letterboxed square* space of the detector input, which
is why no separate aspect correction is needed; the mapping back to source
pixels happens once, at the end, in `square_to_source`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# --- model contract ---------------------------------------------------------

DETECTOR_SIZE = 192
LANDMARK_SIZE = 224
NUM_ANCHORS = 2016
NUM_COORDS = 18
NUM_KEYPOINTS = 21

# SsdAnchorsCalculatorOptions for the palm detector.
ANCHOR_NUM_LAYERS = 4
ANCHOR_MIN_SCALE = 0.1484375
ANCHOR_MAX_SCALE = 0.75
ANCHOR_STRIDES = (8, 16, 16, 16)
ANCHOR_OFFSET = 0.5

# TensorsToDetectionsCalculatorOptions.
SCORE_CLIP = 100.0
DETECTOR_SCORE_THRESHOLD = 0.5
NMS_IOU_THRESHOLD = 0.3

# DetectionsToRects / RectTransformation for the palm -> hand ROI.
ROI_ROTATION_START_KEYPOINT = 0  # wrist centre
ROI_ROTATION_END_KEYPOINT = 2    # middle-finger MCP
ROI_TARGET_ANGLE = math.pi / 2
ROI_SCALE = 2.6
ROI_SHIFT_Y = -0.5

# Palm measurement: the mean of the MCP landmarks, never a fingertip.
MCP_LANDMARKS = (5, 9, 13, 17)
FINGERTIP_LANDMARKS = (4, 8, 12, 16, 20)

# 21-point hand skeleton, used only for bone-length sanity checks.
HAND_BONES = (
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (0, 17),
)


# --- anchors ----------------------------------------------------------------

def ssd_anchors() -> np.ndarray:
    """The 2016 fixed-size anchors, as (x_center, y_center) in [0,1].

    `fixed_anchor_size: true` means every anchor has width == height == 1.0, so
    only the centres are needed downstream. Layers that share a stride are
    merged, exactly as MediaPipe's generator does: stride 8 contributes one
    layer (2 anchors per cell over a 24x24 grid = 1152) and the three stride-16
    layers merge into 6 anchors per cell over a 12x12 grid = 864.
    """
    centers: list[tuple[float, float]] = []
    layer = 0
    while layer < ANCHOR_NUM_LAYERS:
        last = layer
        anchors_per_location = 0
        while last < ANCHOR_NUM_LAYERS and ANCHOR_STRIDES[last] == ANCHOR_STRIDES[layer]:
            # aspect_ratios: [1.0] plus the interpolated-scale anchor -> 2 each.
            anchors_per_location += 2
            last += 1
        stride = ANCHOR_STRIDES[layer]
        fm = math.ceil(DETECTOR_SIZE / stride)
        for y in range(fm):
            for x in range(fm):
                for _ in range(anchors_per_location):
                    centers.append(((x + ANCHOR_OFFSET) / fm, (y + ANCHOR_OFFSET) / fm))
        layer = last
    out = np.asarray(centers, dtype=np.float64)
    if out.shape != (NUM_ANCHORS, 2):
        raise AssertionError(f"anchor generation produced {out.shape}, expected ({NUM_ANCHORS}, 2)")
    return out


# --- detector decode --------------------------------------------------------

@dataclass
class Detection:
    score: float
    xmin: float
    ymin: float
    xmax: float
    ymax: float
    keypoints: np.ndarray  # (7, 2), normalised to the square input

    @property
    def width(self) -> float:
        return self.xmax - self.xmin

    @property
    def height(self) -> float:
        return self.ymax - self.ymin


def decode_detections(
    boxes: np.ndarray,
    scores: np.ndarray,
    anchors: np.ndarray,
    score_threshold: float = DETECTOR_SCORE_THRESHOLD,
) -> list[Detection]:
    """Anchor decode for `Identity` [1,2016,18] and `Identity_1` [1,2016,1]."""
    boxes = np.asarray(boxes, dtype=np.float64).reshape(NUM_ANCHORS, NUM_COORDS)
    raw_scores = np.asarray(scores, dtype=np.float64).reshape(NUM_ANCHORS)
    raw_scores = np.clip(raw_scores, -SCORE_CLIP, SCORE_CLIP)
    probs = 1.0 / (1.0 + np.exp(-raw_scores))

    keep = np.nonzero(probs >= score_threshold)[0]
    scale = float(DETECTOR_SIZE)
    out: list[Detection] = []
    for i in keep:
        ax, ay = anchors[i]
        # reverse_output_order: true -> (x, y, w, h), not (y, x, h, w).
        cx = boxes[i, 0] / scale + ax
        cy = boxes[i, 1] / scale + ay
        w = boxes[i, 2] / scale
        h = boxes[i, 3] / scale
        kps = np.empty((7, 2), dtype=np.float64)
        for k in range(7):
            kps[k, 0] = boxes[i, 4 + 2 * k] / scale + ax
            kps[k, 1] = boxes[i, 5 + 2 * k] / scale + ay
        out.append(Detection(
            score=float(probs[i]),
            xmin=cx - w / 2.0, ymin=cy - h / 2.0,
            xmax=cx + w / 2.0, ymax=cy + h / 2.0,
            keypoints=kps,
        ))
    out.sort(key=lambda d: d.score, reverse=True)
    return out


def iou(a: Detection, b: Detection) -> float:
    ix = max(0.0, min(a.xmax, b.xmax) - max(a.xmin, b.xmin))
    iy = max(0.0, min(a.ymax, b.ymax) - max(a.ymin, b.ymin))
    inter = ix * iy
    union = a.width * a.height + b.width * b.height - inter
    return inter / union if union > 0 else 0.0


def weighted_nms(
    detections: list[Detection],
    iou_threshold: float = NMS_IOU_THRESHOLD,
    max_detections: int = 2,
) -> list[Detection]:
    """MediaPipe's weighted NMS: each survivor is a score-weighted blend of its
    own suppression cluster, which is why box edges move slightly."""
    remaining = sorted(detections, key=lambda d: d.score, reverse=True)
    kept: list[Detection] = []
    while remaining and len(kept) < max_detections:
        best = remaining[0]
        cluster = [d for d in remaining if iou(best, d) > iou_threshold]
        rest = [d for d in remaining if iou(best, d) <= iou_threshold]
        total = sum(d.score for d in cluster)
        if total > 0:
            w = np.array([d.score for d in cluster], dtype=np.float64) / total
            blended = Detection(
                score=best.score,
                xmin=float(sum(wi * d.xmin for wi, d in zip(w, cluster))),
                ymin=float(sum(wi * d.ymin for wi, d in zip(w, cluster))),
                xmax=float(sum(wi * d.xmax for wi, d in zip(w, cluster))),
                ymax=float(sum(wi * d.ymax for wi, d in zip(w, cluster))),
                keypoints=sum(wi * d.keypoints for wi, d in zip(w, cluster)),
            )
        else:
            blended = best
        kept.append(blended)
        remaining = rest
    return kept


# --- ROI --------------------------------------------------------------------

@dataclass
class Roi:
    """A rotated square ROI in the detector's normalised square space."""
    x_center: float
    y_center: float
    size: float       # normalised side length (square)
    rotation: float   # radians
    source: str = "detector"
    extra: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "xCenter": self.x_center, "yCenter": self.y_center,
            "size": self.size, "rotation": self.rotation, "source": self.source,
        }


def _normalise_angle(a: float) -> float:
    return a - 2 * math.pi * math.floor((a + math.pi) / (2 * math.pi))


def detection_to_roi(det: Detection) -> Roi:
    """`DetectionsToRects` + `RectTransformation` for the palm detection."""
    start = det.keypoints[ROI_ROTATION_START_KEYPOINT]
    end = det.keypoints[ROI_ROTATION_END_KEYPOINT]
    rotation = _normalise_angle(
        ROI_TARGET_ANGLE - math.atan2(-(end[1] - start[1]), end[0] - start[0])
    )

    cx = (det.xmin + det.xmax) / 2.0
    cy = (det.ymin + det.ymax) / 2.0
    w, h = det.width, det.height
    # shift_x = 0, so only the shift_y terms survive; the shift is applied along
    # the *rotated* axes.
    cx += -h * ROI_SHIFT_Y * math.sin(rotation)
    cy += h * ROI_SHIFT_Y * math.cos(rotation)
    size = max(w, h) * ROI_SCALE
    return Roi(x_center=cx, y_center=cy, size=size, rotation=rotation)


def landmarks_to_roi(landmarks_sq: np.ndarray, scale: float = 2.0) -> Roi:
    """Next-frame ROI from the previous landmark result: the tracking loopback.

    Rotation comes from landmark 0 (wrist) -> landmark 9 (middle MCP); the box
    is the landmark bounding box, squared on its long side and scaled.
    """
    pts = np.asarray(landmarks_sq, dtype=np.float64)[:, :2]
    start, end = pts[0], pts[9]
    rotation = _normalise_angle(
        ROI_TARGET_ANGLE - math.atan2(-(end[1] - start[1]), end[0] - start[0])
    )
    xmin, ymin = pts.min(axis=0)
    xmax, ymax = pts.max(axis=0)
    cx, cy = (xmin + xmax) / 2.0, (ymin + ymax) / 2.0
    size = max(xmax - xmin, ymax - ymin) * scale
    return Roi(x_center=cx, y_center=cy, size=size, rotation=rotation, source="landmarks")


def roi_matrix(roi: Roi) -> np.ndarray:
    """2x3 affine mapping crop-normalised [0,1]^2 -> square-normalised [0,1]^2.

    This is exactly the transform the WGSL crop shader has to implement, and its
    inverse is what maps landmarks back out of the crop.
    """
    c, s = math.cos(roi.rotation), math.sin(roi.rotation)
    half = roi.size / 2.0
    return np.array([
        [2 * half * c, -2 * half * s, roi.x_center - half * c + half * s],
        [2 * half * s, 2 * half * c, roi.y_center - half * s - half * c],
    ], dtype=np.float64)


def crop_to_square(roi: Roi, pts_crop: np.ndarray) -> np.ndarray:
    """Map landmark points from crop space [0,1] into square space."""
    m = roi_matrix(roi)
    pts = np.asarray(pts_crop, dtype=np.float64)
    xy = pts[:, :2]
    out = np.empty_like(pts)
    out[:, 0] = m[0, 0] * xy[:, 0] + m[0, 1] * xy[:, 1] + m[0, 2]
    out[:, 1] = m[1, 0] * xy[:, 0] + m[1, 1] * xy[:, 1] + m[1, 2]
    if pts.shape[1] > 2:
        out[:, 2:] = pts[:, 2:] * roi.size
    return out


# --- letterbox / source mapping --------------------------------------------

@dataclass
class Letterbox:
    """Aspect-preserving fit of a WxH source into a square SxS input."""
    src_w: int
    src_h: int
    size: int = DETECTOR_SIZE

    @property
    def scale(self) -> float:
        return self.size / max(self.src_w, self.src_h)

    @property
    def pad_x(self) -> float:
        return (self.size - self.src_w * self.scale) / 2.0

    @property
    def pad_y(self) -> float:
        return (self.size - self.src_h * self.scale) / 2.0

    def as_dict(self) -> dict:
        return {
            "srcW": self.src_w, "srcH": self.src_h, "size": self.size,
            "scale": self.scale, "padX": self.pad_x, "padY": self.pad_y,
        }


def square_to_source(lb: Letterbox, pts_sq: np.ndarray) -> np.ndarray:
    """Square-normalised [0,1] -> source pixel coordinates."""
    pts = np.asarray(pts_sq, dtype=np.float64)
    out = pts.copy()
    out[:, 0] = (pts[:, 0] * lb.size - lb.pad_x) / lb.scale
    out[:, 1] = (pts[:, 1] * lb.size - lb.pad_y) / lb.scale
    return out


def letterbox_image(img: np.ndarray, size: int = DETECTOR_SIZE):
    """uint8 HxWx3 -> (uint8 square SxSx3, Letterbox). Black padding."""
    from PIL import Image
    h, w = img.shape[:2]
    lb = Letterbox(w, h, size)
    tw, th = max(1, round(w * lb.scale)), max(1, round(h * lb.scale))
    resized = np.asarray(Image.fromarray(img).resize((tw, th), Image.BILINEAR))
    canvas = np.zeros((size, size, 3), dtype=np.uint8)
    ox, oy = int(round(lb.pad_x)), int(round(lb.pad_y))
    canvas[oy:oy + th, ox:ox + tw] = resized
    return canvas, lb


def to_nhwc_float(square_u8: np.ndarray) -> np.ndarray:
    """uint8 SxSx3 -> float32 [1,S,S,3] in [0,1], which is what both graphs take."""
    return (square_u8.astype(np.float32) / 255.0)[None, ...]


def crop_roi(square_u8: np.ndarray, roi: Roi, size: int = LANDMARK_SIZE) -> np.ndarray:
    """Sample a rotated ROI out of a square image into [1,size,size,3] float32.

    Bilinear, matching what a WGSL `textureSampleLevel` with linear filtering
    produces; out-of-bounds samples are black, as MediaPipe's border mode is.
    """
    sq = np.asarray(square_u8).astype(np.float32)
    sh, sw = sq.shape[:2]
    m = roi_matrix(roi)
    uu, vv = np.meshgrid((np.arange(size) + 0.5) / size, (np.arange(size) + 0.5) / size)
    xs = m[0, 0] * uu + m[0, 1] * vv + m[0, 2]
    ys = m[1, 0] * uu + m[1, 1] * vv + m[1, 2]

    fx = xs * sw - 0.5
    fy = ys * sh - 0.5
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    tx = (fx - x0)[..., None]
    ty = (fy - y0)[..., None]

    def at(ix, iy):
        return sq[np.clip(iy, 0, sh - 1), np.clip(ix, 0, sw - 1)]

    top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx
    bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx
    out = (top * (1 - ty) + bot * ty) / 255.0
    inside = (xs >= 0) & (xs < 1) & (ys >= 0) & (ys < 1)
    out[~inside] = 0.0
    return out.astype(np.float32)[None, ...]


# --- landmark decode --------------------------------------------------------

@dataclass
class HandResult:
    presence: float
    handedness: float
    landmarks_crop: np.ndarray    # (21,3) normalised to the crop
    landmarks_square: np.ndarray  # (21,3) in detector-square space
    roi: Roi

    def palm_centroid_square(self) -> np.ndarray:
        """The measurement the brush consumes: mean of the MCP landmarks."""
        return self.landmarks_square[list(MCP_LANDMARKS), :2].mean(axis=0)


def decode_landmarks(raw, presence, handedness, roi: Roi) -> HandResult:
    """`Identity` [1,63] is in *crop pixels*, so divide by the crop size."""
    pts = np.asarray(raw, dtype=np.float64).reshape(NUM_KEYPOINTS, 3) / float(LANDMARK_SIZE)
    return HandResult(
        presence=float(np.asarray(presence).reshape(-1)[0]),
        handedness=float(np.asarray(handedness).reshape(-1)[0]),
        landmarks_crop=pts,
        landmarks_square=crop_to_square(roi, pts),
        roi=roi,
    )
