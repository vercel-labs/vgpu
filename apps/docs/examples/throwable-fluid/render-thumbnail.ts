// The gallery thumbnail: the live tracker, wake and pipeline fed by a scripted
// throw instead of the DOM. The orb is picked up, swung through a curve and
// released into Motion's own inertia generator, which carries it into the top
// wall (the splash) and springs it back; an idle flick then sends it back
// across its wake, and the frame is caught mid-coast. The owning script
// disposes the Gpu, which releases every resource.

import { inertia } from 'motion';
import { frame, type Gpu, type Target } from 'vgpu';

import { createOrbTracker, type Vec2 } from './orb-tracker';
import { DEFAULT_SETTINGS, inertiaOptions } from './orb-store';
import { createPipeline, DEFAULT_TUNING, FLUID_DAMPING, INK, type Scene } from './pipeline';
import { createWake } from './wake';

interface ThumbOptions {
  readonly warmupFrames?: number;
  /** Seconds into the scripted throw. */
  readonly time?: number;
  readonly dt?: number;
}

// The scene is laid out in CSS px at the fullscreen preview size; larger
// targets render the same layout at a higher DPR.
const VIEW = [1280, 720] as const;
const RADIUS = DEFAULT_SETTINGS.size / 2;
const RANGE = [VIEW[0] - DEFAULT_SETTINGS.size, VIEW[1] - DEFAULT_SETTINGS.size] as const;

// Hover, press, a swing through a Bézier curve of orb centres, the release,
// and an idle flick back across the wake.
const PRESS_AT = 0.12;
const DRAG_AT = 0.22;
const DRAG_FOR = 0.55;
const FLICK_AT = 1.5;
const PATH: readonly Vec2[] = [
  [384, 403],
  [230, 580],
  [500, 670],
  [650, 440],
];
const FLICK: Vec2 = [-1300, 700];
const SCALE_SPRING = { stiffness: 420, damping: 22 };

type Generator = ReturnType<typeof inertia>;

function bezier(u: number): { point: Vec2; tangent: Vec2 } {
  const [p0, p1, p2, p3] = PATH as [Vec2, Vec2, Vec2, Vec2];
  const v = 1 - u;
  const point = (axis: 0 | 1) =>
    v * v * v * p0[axis] + 3 * v * v * u * p1[axis] + 3 * v * u * u * p2[axis] + u * u * u * p3[axis];
  const tangent = (axis: 0 | 1) =>
    3 * v * v * (p1[axis] - p0[axis]) + 6 * v * u * (p2[axis] - p1[axis]) + 3 * u * u * (p3[axis] - p2[axis]);
  return { point: [point(0), point(1)], tangent: [tangent(0), tangent(1)] };
}

/** The orb's top-left layout offset and scale over time, as Motion would write them. */
function createThrow() {
  const options = inertiaOptions(DEFAULT_SETTINGS);
  let coast: { start: number; axes: [Generator, Generator] } | null = null;
  let offset: Vec2 = [PATH[0]![0] - RADIUS, PATH[0]![1] - RADIUS];
  let scale = 1;
  let scaleVelocity = 0;

  const release = (start: number, from: Vec2, velocity: Vec2) => {
    coast = {
      start,
      axes: [
        inertia({ keyframes: [from[0]], velocity: velocity[0], min: 0, max: RANGE[0], ...options }),
        inertia({ keyframes: [from[1]], velocity: velocity[1], min: 0, max: RANGE[1], ...options }),
      ],
    };
  };

  return (time: number, dt: number): { offset: Vec2; scale: number } => {
    if (time >= DRAG_AT && time < DRAG_AT + DRAG_FOR) {
      const { point } = bezier((time - DRAG_AT) / DRAG_FOR);
      offset = [point[0] - RADIUS, point[1] - RADIUS];
    } else if (time >= DRAG_AT + DRAG_FOR && !coast) {
      const { point, tangent } = bezier(1);
      release(DRAG_AT + DRAG_FOR, [point[0] - RADIUS, point[1] - RADIUS], [tangent[0] / DRAG_FOR, tangent[1] / DRAG_FOR]);
    }
    if (time >= FLICK_AT && coast && coast.start < FLICK_AT) {
      // As the page's flick does, from the wall if the bounce still carries it past.
      release(FLICK_AT, [Math.min(RANGE[0], Math.max(0, offset[0])), Math.min(RANGE[1], Math.max(0, offset[1]))], FLICK);
    }
    if (coast) {
      const elapsed = (time - coast.start) * 1000;
      offset = [coast.axes[0].next(elapsed).value, coast.axes[1].next(elapsed).value];
    }

    // whileHover, then whileTap/whileDrag, then back to rest after the release.
    const goal = time < PRESS_AT ? 1.05 : time < DRAG_AT + DRAG_FOR ? 1.12 : 1;
    scaleVelocity += (-SCALE_SPRING.stiffness * (scale - goal) - SCALE_SPRING.damping * scaleVelocity) * dt;
    scale += scaleVelocity * dt;
    return { offset, scale };
  };
}

export async function renderThumbnail(gpu: Gpu, target: Target, options: ThumbOptions = {}): Promise<void> {
  try {
    const pipeline = createPipeline(gpu, { size: target.size, quality: DEFAULT_TUNING.quality });
    await pipeline.prewarm(target);

    const dt = options.dt ?? 1 / 60;
    const frames = Math.max(1, Math.round(options.warmupFrames ?? 60));
    // The throw always plays from its start; only the last frames are drawn.
    const steps = Math.max(frames, Math.round((options.time ?? 2) / dt));
    const scripted = createThrow();
    const tracker = createOrbTracker();
    const wake = createWake();
    const view = { left: 0, top: 0, width: VIEW[0], height: VIEW[1] };

    for (let i = 1; i <= steps; i++) {
      const { offset, scale } = scripted(i * dt, dt);
      const radius = RADIUS * scale;
      const orbRect = {
        left: offset[0] + RADIUS - radius,
        top: offset[1] + RADIUS - radius,
        width: radius * 2,
        height: radius * 2,
      };
      const orb = tracker.update({ orb: orbRect, bounds: view, canvas: view, scale }, dt);
      const stir = wake.update({ orb, dt, ripples: 0, gain: 1 });
      const scene: Scene = {
        dt,
        view: VIEW,
        orb: stir.orb,
        splash: stir.splash,
        palette: DEFAULT_TUNING.palette,
        phase: stir.phase,
        ink: INK,
        drag: stir.drag,
        params: {
          viscosity: DEFAULT_TUNING.viscosity,
          vorticity: DEFAULT_TUNING.vorticity,
          dissipation: DEFAULT_TUNING.dissipation,
          damping: FLUID_DAMPING,
        },
        look: { refraction: DEFAULT_TUNING.refraction, dispersion: DEFAULT_TUNING.dispersion },
      };
      const draw = i > steps - frames;
      frame(gpu, (currentFrame) => {
        pipeline.simulate(currentFrame, scene);
        if (draw) pipeline.draw(currentFrame, target, scene);
      });
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
