import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'air-painting',
  title: 'Air Painting',
  // All of the example's prose lives here, not inside the frame: the example
  // itself is the canvas plus two buttons.
  description:
    "Paint in the air with both hands. ONNX Runtime Web runs MoveNet SinglePose Lightning on WebGPU, vgpu adopts ORT's device, and WGSL reads the 17 GPU-resident keypoints through a non-owning zero-copy wrapper: the landmarks are smoothed, unletterboxed and turned into strokes without a single byte travelling back to the CPU. A fixed 8x8 Bayer dither covers everything except the strokes, which reveal the raw camera. Raise either hand into frame and move it to draw \u2014 both arms are independent brushes with their own state machines, so one hand leaving frame never breaks the other's line. MoveNet has no hand keypoint, so each brush paints at the hand, extrapolated ~30% of the forearm past the wrist; a low-confidence elbow falls back to the wrist itself. Confidence has to reach 0.45 to start a stroke and stays live down to 0.30, and losing a hand for two results breaks its line instead of drawing a connector across the frame. Two honest caveats. Camera preprocessing is CPU-side: the committed graph takes uint8 [1,192,192,3] and a GPU-buffer input tensor was rejected by the runtime, so each inference uploads a letterboxed 110 kB frame \u2014 the zero-copy claim is about the output. And without a camera the example runs a visual demo that replays a canned frame and a fixed two-handed synthetic trajectory through the same wrist, paint and composite shaders; it shows the visuals only and proves nothing about ONNX Runtime interop, so enable the camera for that. Video never leaves this device and is never uploaded anywhere.",
  tags: ['machine-learning', 'onnx', 'pose-estimation', 'ordered-dithering', 'shader'],
  capabilities: [
    'webgpu',
    'machine-learning',
    'external-device',
    'zero-copy',
    'gpu-buffer-interop',
    'storage-buffers',
    'compute-shader',
    'camera-input',
    'textures',
    'continuous-rendering',
    'responsive-canvas',
  ],
  // The thumbnail replays the canned frame and the 24 golden keypoint buffers
  // through the production shaders at a fixed dt. No ORT, webcam or network is
  // involved, and nothing about it depends on wall-clock time.
  thumb: {
    warmupFrames: 1,
    dt: 1 / 30,
    note: 'Canned frame + golden two-handed [1,1,17,3] trajectory through the real wrist/paint/composite shaders; no ORT in the Node path.',
  },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'demo-runtime.ts',
    'visual-pipeline.ts',
    'inference-scheduler.ts',
    'camera-source.ts',
    'preprocess.ts',
    'pose-contract.ts',
    'fixtures.ts',
    'wrist.wgsl',
    'paint.wgsl',
    'composite.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
