export const DETECTOR_URL = "/models/mediapipe-hands/palm-detector.onnx";
export const LANDMARK_URL = "/models/mediapipe-hands/hand-landmark.onnx";

export const DETECTOR_INPUT_NAME = "input_1";
export const LANDMARK_INPUT_NAME = "input_1";
export const DETECTOR_BOXES_OUTPUT = "Identity";
export const DETECTOR_SCORES_OUTPUT = "Identity_1";
export const LANDMARK_POINTS_OUTPUT = "Identity";
export const LANDMARK_PRESENCE_OUTPUT = "Identity_1";

export const DETECTOR_SIZE = 192;
export const DETECTOR_INPUT_DIMS = [
  1,
  DETECTOR_SIZE,
  DETECTOR_SIZE,
  3,
] as const;
export const DETECTOR_INPUT_BYTES = DETECTOR_SIZE * DETECTOR_SIZE * 3 * 4;

export const LANDMARK_SIZE = 224;
export const LANDMARK_INPUT_DIMS = [
  1,
  LANDMARK_SIZE,
  LANDMARK_SIZE,
  3,
] as const;
export const LANDMARK_INPUT_BYTES = LANDMARK_SIZE * LANDMARK_SIZE * 3 * 4;

export const NUM_ANCHORS = 2016;
export const NUM_COORDS = 18;
export const NUM_LANDMARKS = 21;
export const LANDMARK_POINTS_DIMS = [1, NUM_LANDMARKS * 3] as const;
// 63 floats are padded to the binding size returned by ORT.
export const LANDMARK_POINTS_BUFFER_BYTES = 256;

export const ANCHOR_NUM_LAYERS = 4;
export const ANCHOR_STRIDES = [8, 16, 16, 16] as const;
export const ANCHOR_OFFSET = 0.5;
export const DETECTOR_SCORE_THRESHOLD = 0.5;
export const NMS_IOU_THRESHOLD = 0.3;

export const ROI_ROTATION_START_KEYPOINT = 0;
export const ROI_ROTATION_END_KEYPOINT = 2;
export const ROI_TARGET_ANGLE = Math.PI / 2;
export const ROI_SCALE = 2.6;
export const ROI_SHIFT_Y = -0.5;
export const MCP_LANDMARKS = [5, 9, 13, 17] as const;

export const PRESENCE_ENTER = 0.45;
export const PRESENCE_STAY = 0.3;
export const TRACK_LOST_RESULTS = 2;
export const ROI_MIN_FRACTION = 0.02;
export const ROI_MAX_FRACTION = 2.5;
export const MAX_HANDS = 2;
