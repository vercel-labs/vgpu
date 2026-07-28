/**
 * Frozen model contract for the two MediaPipe hand graphs.
 *
 * Two graphs, not one. MediaPipe's hand solution is a **palm detector** that
 * finds hands in a whole frame and a **landmark model** that reads 21 points out
 * of one tight, rotated crop. Everything between them — anchor decoding, weighted
 * NMS, the palm-to-ROI transform, the crop itself and the landmark-to-next-ROI
 * loopback — is host work that lives in `hand-pipeline.ts`. The ONNX files are
 * only the two neural halves; converting them is not the same as having a hand
 * pipeline, and this module is where that boundary is written down.
 *
 * Every number here was measured off the converted graphs and confirmed in a
 * browser on real hardware by `/hand-gate/` (see provenance.md for the run).
 * Nothing is copied from a model card: the card for this family is wrong about
 * dtypes in the same way MoveNet's was.
 */

/** Same-origin model assets; see public/models/mediapipe-hands/provenance.md. */
export const DETECTOR_URL = '/models/mediapipe-hands/palm-detector.onnx';
export const LANDMARK_URL = '/models/mediapipe-hands/hand-landmark.onnx';

export const DETECTOR_BYTES = 4_589_374;
export const LANDMARK_BYTES = 10_903_457;

/**
 * SHA-256 of the exact redistributed bytes.
 *
 * These pin *these copies*, not the conversion. `tf2onnx` is not byte
 * reproducible — seven runs of the same input through the same pinned toolchain
 * produced seven different digests, because generated tensor names come off a
 * process-global counter. The reproducibility contract is the canonical graph
 * digest below, which is name-independent and was stable across all of them.
 */
export const DETECTOR_SHA256 = '836e25f3f6d365cd7a67c36ad69876c3da9b540cb434a26e9d100a00938cfd2e';
export const LANDMARK_SHA256 = '6d98325697613ffb250a29bedd78450f87ecf1968797f9c54829cda45b44c00c';

/** Canonical, name-independent graph digests; see tools/models/mediapipe-hands/graph-digest.py. */
export const DETECTOR_GRAPH_DIGEST =
  'a19a133771a070d26591f473695b5cbcffb1af148c7b5165162eed8aeefd6ac2';
export const LANDMARK_GRAPH_DIGEST =
  '416a84388303c48900c5edafc3f06d28126e0baf8772860af1c19e9d8a2052cc';

/**
 * Both graphs name their input `input_1` and their outputs `Identity*`. Sessions
 * are asked for their own names first; these are the documented fallback and the
 * value the contract test asserts.
 */
export const DETECTOR_INPUT_NAME = 'input_1';
export const LANDMARK_INPUT_NAME = 'input_1';

/** Detector: boxes + 7 palm keypoints per anchor, and one score per anchor. */
export const DETECTOR_BOXES_OUTPUT = 'Identity';
export const DETECTOR_SCORES_OUTPUT = 'Identity_1';

/** Landmark: 21 xyz in crop pixels, hand presence, handedness, 21 world xyz. */
export const LANDMARK_POINTS_OUTPUT = 'Identity';
export const LANDMARK_PRESENCE_OUTPUT = 'Identity_1';
export const LANDMARK_HANDEDNESS_OUTPUT = 'Identity_2';
export const LANDMARK_WORLD_OUTPUT = 'Identity_3';

/**
 * **float32**, both graphs, in and out.
 *
 * The upstream `.task` bundle is advertised as float16 and its TFLite members
 * genuinely are, but `tf2onnx` dequantizes on conversion, so the ONNX I/O is
 * plain float32. Assuming otherwise would have produced a silently wrong input
 * tensor; the gate asserts the dtype rather than trusting the filename.
 */
export const MODEL_IO_DTYPE = 'float32' as const;

/** Square detector input side, in model pixels. */
export const DETECTOR_SIZE = 192;
export const DETECTOR_INPUT_ELEMENTS = DETECTOR_SIZE * DETECTOR_SIZE * 3;
export const DETECTOR_INPUT_DIMS = [1, DETECTOR_SIZE, DETECTOR_SIZE, 3] as const;
export const DETECTOR_INPUT_BYTES = DETECTOR_INPUT_ELEMENTS * 4;

/** Square landmark crop side, in crop pixels. Landmark xy come back in this space. */
export const LANDMARK_SIZE = 224;
export const LANDMARK_INPUT_ELEMENTS = LANDMARK_SIZE * LANDMARK_SIZE * 3;
export const LANDMARK_INPUT_DIMS = [1, LANDMARK_SIZE, LANDMARK_SIZE, 3] as const;
export const LANDMARK_INPUT_BYTES = LANDMARK_INPUT_ELEMENTS * 4;

/** SSD anchors baked into the detector head. */
export const NUM_ANCHORS = 2016;
/** 4 box terms + 7 palm keypoints * 2. */
export const NUM_COORDS = 18;
export const DETECTOR_BOXES_DIMS = [1, NUM_ANCHORS, NUM_COORDS] as const;
export const DETECTOR_SCORES_DIMS = [1, NUM_ANCHORS, 1] as const;

/** 21 landmarks, xyz each. */
export const NUM_LANDMARKS = 21;
export const LANDMARK_STRIDE = 3;
export const LANDMARK_ELEMENTS = NUM_LANDMARKS * LANDMARK_STRIDE;
export const LANDMARK_POINTS_DIMS = [1, LANDMARK_ELEMENTS] as const;
export const LANDMARK_SCALAR_DIMS = [1, 1] as const;

/**
 * Buffer sizes the pipeline allocates for borrowed landmark outputs.
 *
 * 63 floats is 252 bytes of payload; ORT hands back a buffer rounded up, and the
 * fixtures allocate the same rounded size so the bind group layout is byte
 * identical in the browser, in the thumbnail and in the tests.
 */
export const LANDMARK_POINTS_BUFFER_BYTES = 256;
export const LANDMARK_SCALAR_BUFFER_BYTES = 4;

/**
 * SSD anchor generation, transcribed from the `SsdAnchorsCalculatorOptions` in
 * MediaPipe's `palm_detection_*.pbtxt`. Four feature layers over a 192x192 input
 * produce exactly {@link NUM_ANCHORS} anchors, which the anchor test asserts.
 */
export const ANCHOR_NUM_LAYERS = 4;
export const ANCHOR_MIN_SCALE = 0.1484375;
export const ANCHOR_MAX_SCALE = 0.75;
export const ANCHOR_STRIDES = [8, 16, 16, 16] as const;
export const ANCHOR_OFFSET = 0.5;

/** Logit clamp before the sigmoid, from `TensorsToDetectionsCalculatorOptions`. */
export const SCORE_CLIP = 100;
/** Minimum detector confidence for a palm to enter NMS. */
export const DETECTOR_SCORE_THRESHOLD = 0.5;
/** IoU above which weighted NMS folds two detections together. */
export const NMS_IOU_THRESHOLD = 0.3;

/**
 * Palm box to landmark ROI, from `DetectionsToRectsCalculator` plus
 * `RectTransformationCalculator`.
 *
 * The rotation is measured from palm keypoint 0 (wrist) to keypoint 2 (middle
 * finger MCP) and rotated so that vector points "up" in the crop, which is the
 * canonical pose the landmark model was trained on. Feeding it an unrotated crop
 * measurably degrades the landmarks, so this is not cosmetic.
 */
export const ROI_ROTATION_START_KEYPOINT = 0;
export const ROI_ROTATION_END_KEYPOINT = 2;
export const ROI_TARGET_ANGLE = Math.PI / 2;
/** The palm box is expanded to 2.6x so the crop contains the whole hand, not just the palm. */
export const ROI_SCALE = 2.6;
/** ...and shifted along the hand's own axis so the fingers, not the forearm, get the room. */
export const ROI_SHIFT_Y = -0.5;

/**
 * Landmark indices this example actually reads.
 *
 * The brush paints at the mean of the four **MCP** knuckles. Not a fingertip:
 * this is a palm-sized wipe, and index 8 skates around every time a finger
 * curls. Not the wrist either — landmark 0 sits at the base of the hand and
 * would drag the stroke down onto the forearm. The knuckle centroid is the part
 * of the hand that stays put while the fingers move, which is exactly the
 * property a brush anchor needs.
 */
export const MCP_LANDMARKS = [5, 9, 13, 17] as const;
export const WRIST_LANDMARK = 0;
export const FINGERTIP_LANDMARKS = [4, 8, 12, 16, 20] as const;

/**
 * Hand presence gate.
 *
 * MediaPipe publishes one presence scalar per hand and no trustworthy per-point
 * score, so presence is the only honest confidence this pipeline has. It is
 * emphatically **not** the detector score: the fixture screen turned up real
 * photographs scoring 0.58 at the detector whose landmarks came back with
 * presence 0.017. Carrying a stale detector score forward as if it were current
 * evidence would paint confident strokes from a hand that is not there.
 */
export const PRESENCE_ENTER = 0.45;
export const PRESENCE_STAY = 0.3;

/**
 * Tracking cadence, following `hand_landmark_tracking_cpu.pbtxt`.
 *
 * The detector is the expensive half, so MediaPipe runs it only when it has to:
 * once at startup, then never again while the landmark model keeps returning a
 * present hand inside a sane ROI. A slot that goes bad for
 * {@link TRACK_LOST_RESULTS} consecutive results is dropped and the detector is
 * rerun to reacquire — keeping whichever slot is still healthy.
 */
export const TRACK_LOST_RESULTS = 2;

/**
 * Largest plausible ROI side as a fraction of the frame's short side, and the
 * smallest. An ROI outside this band means the loopback has diverged, which is
 * treated as a lost track rather than fed back in.
 */
export const ROI_MIN_FRACTION = 0.02;
export const ROI_MAX_FRACTION = 2.5;

/** Two hands, so two persistent track slots. */
export const MAX_HANDS = 2;
