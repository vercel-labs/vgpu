// Motion is the conductor. An `animate()` sequence plays the timeline (one
// labelled segment per shape) into a playhead motion value, its playback
// controls give play, pause, scrub, speed and jump, and Motion's frameloop
// calls this renderer in `render` every frame. There the renderer reads the
// playhead and the pointer's spring values, lists the morphs in flight and
// renders them in the same browser frame. Nothing per frame goes through React.

import GUI, { type Controller } from 'lil-gui';
import {
  animate,
  cancelFrame,
  frame as motionFrame,
  frameData,
  motionValue,
  springValue,
  type AnimationPlaybackControls,
  type AnimationSequence,
  type MotionValue,
} from 'motion';
import { clock, frame, init, surface, type Gpu, type Surface } from 'vgpu';

import {
  BURST_SPREAD,
  DEFAULT_SPRING,
  DEFAULT_STAGGER,
  LOOP,
  PATTERNS,
  SEGMENT,
  SHAPES,
  SPRING_PRESETS,
  STAGGER_EASES,
  activeSegments,
  arrivalCue,
  bakeSpring,
  bakeStagger,
  baseShape,
  cameraAt,
  criticallyDamped,
  currentShape,
  morphWindow,
  wrapTime,
  type PatternChoice,
  type SpringPreset,
  type SpringTable,
  type StaggerEase,
} from './choreography';
import {
  COLOR_MODES,
  DEFAULT_COUNT,
  DEFAULT_LOOK,
  MAX_BURSTS,
  PARTICLE_COUNTS,
  createPipeline,
  type Burst,
  type ColorMode,
  type Pipeline,
} from './pipeline';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Hosts the lil-gui panel and receives pointer input; defaults to the canvas parent. */
  readonly container?: HTMLElement;
}

interface Settings {
  time: number;
  speed: number;
  shape: number;
  preset: SpringPreset | 'Custom';
  stiffness: number;
  damping: number;
  mass: number;
  pattern: PatternChoice;
  spread: number;
  ease: StaggerEase;
  count: number;
  colorMode: ColorMode;
  streaks: number;
  trails: boolean;
  bloom: boolean;
  exposure: number;
  calm: boolean;
}

/** A click burst in flight; `born` is wall-clock seconds, so bursts ignore the timeline. */
interface LiveBurst extends Burst {
  age: number;
  readonly born: number;
}

const MAX_DPR = 2;
const GUI_OPEN_MIN_WIDTH = 900;
/** Seconds between GUI refreshes of the playhead. */
const GUI_REFRESH = 0.2;
/** Share of the previous frame a 60 fps frame keeps when trails are on. */
const TRAIL_KEEP = 0.8;
/** Timeline seconds per frame beyond which the playhead is treated as a cut. */
const TRAIL_CUT = 0.25;
const BURST_AMPLITUDE = 0.2;
/** Calm mode: same choreography, gentler everywhere. */
const CALM = { speed: 0.6, push: 0.4, burst: 0.35 } as const;

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Teardown must run to completion even when one step throws.
  }
}

/** The timeline: one linear segment of the playhead per shape, labelled with its id. */
export function timelineSequence(playhead: MotionValue<number>): AnimationSequence {
  return SHAPES.flatMap((shape, k) => [
    shape.id,
    [playhead, [k * SEGMENT, (k + 1) * SEGMENT], { duration: SEGMENT, ease: 'linear' }],
  ]) as AnimationSequence;
}

/** Shortest way round the loop from `from` to the cue at `to`, in timeline seconds. */
export function jumpDelta(from: number, to: number): number {
  const delta = wrapTime(to - from);
  return delta > LOOP / 2 ? delta - LOOP : delta;
}

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined }: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let pipeline: Pipeline | undefined;
  let gui: GUI | undefined;
  let motion: MediaQueryList | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let ticking = false;

  const settings: Settings = {
    time: 0,
    speed: 1,
    shape: 0,
    preset: 'Bouncy',
    ...DEFAULT_SPRING,
    pattern: 'auto',
    ...DEFAULT_STAGGER,
    count: DEFAULT_COUNT,
    colorMode: DEFAULT_LOOK.colorMode,
    streaks: DEFAULT_LOOK.streak,
    trails: false,
    bloom: DEFAULT_LOOK.bloom,
    exposure: DEFAULT_LOOK.exposure,
    calm: false,
  };

  // Motion state: the timeline, the pointer's springs and the jump tween.
  const playhead = motionValue(0);
  const pointerX = motionValue(0);
  const pointerY = motionValue(0);
  const pushTarget = motionValue(0);
  const sprungX = springValue(pointerX, { stiffness: 260, damping: 24 });
  const sprungY = springValue(pointerY, { stiffness: 260, damping: 24 });
  // Underdamped: when the pointer leaves, the push overshoots into a pull and the swarm springs back.
  const push = springValue(pushTarget, { stiffness: 170, damping: 9 });
  let controls: AnimationPlaybackControls | undefined;
  let jump: AnimationPlaybackControls | undefined;
  let playing = true;
  let scrubbing: { resume: boolean } | undefined;

  let spring: SpringTable = bakeSpring(DEFAULT_SPRING);
  let inFlight = 0;
  let wall = 0;
  let sinceGui = 0;
  let lastTime = 0;
  let size: readonly [number, number] = [1, 1];
  let pointerRadius = 1;
  const bursts: LiveBurst[] = [];
  const origins = new Map<number, readonly [number, number]>();
  let lastPointer: readonly [number, number] = [0, 0];
  let hovering = false;
  let pressed: { x: number; y: number } | undefined;

  const controllers: Partial<Record<'time' | 'shape' | 'play' | 'preset' | 'spring' | 'calm', Controller[]>> = {};
  const refresh = (key: keyof typeof controllers) => controllers[key]?.forEach((controller) => controller.updateDisplay());

  const rebake = () => {
    const base = { stiffness: settings.stiffness, damping: settings.damping, mass: settings.mass };
    spring = bakeSpring(settings.calm ? criticallyDamped(base) : base);
    pipeline?.setSpring(spring, bakeStagger(settings.spread, settings.ease), settings.spread);
    inFlight = morphWindow(settings.spread, spring.duration);
  };

  const applyLook = () => {
    pipeline?.setLook({
      colorMode: settings.colorMode,
      streak: settings.calm ? 0 : settings.streaks,
      bloom: settings.bloom,
      exposure: settings.exposure,
    });
  };

  const applySpeed = () => {
    if (controls) controls.speed = settings.speed * (settings.calm ? CALM.speed : 1);
  };

  // ------------------------------------------------------------ timeline

  const setPlaying = (next: boolean) => {
    playing = next;
    scrubbing = undefined;
    if (next) controls?.play();
    else controls?.pause();
    controllers.play?.forEach((controller) => controller.name(next ? 'Pause' : 'Play'));
  };

  const stopJump = () => {
    jump?.stop();
    jump = undefined;
  };

  const scrub = (time: number) => {
    stopJump();
    if (!scrubbing) {
      scrubbing = { resume: playing };
      if (playing) controls?.pause();
    }
    if (controls) controls.time = time;
  };

  const endScrub = () => {
    if (scrubbing?.resume && playing) controls?.play();
    scrubbing = undefined;
  };

  /** A fast-forward (or rewind) of the timeline itself: every state on the way is the real one. */
  const jumpTo = (shape: number) => {
    if (!controls) return;
    stopJump();
    let from = controls.time;
    const delta = jumpDelta(from, arrivalCue(shape));
    // Paused, land where the shape has formed; playing, land on its cue and watch it form.
    const settle = playing ? 0 : Math.min(settings.spread + spring.duration * 0.7, SEGMENT - 0.2);
    // The timeline starts at 0: rewinding past it starts from the same moment one loop later.
    if (from + delta + settle < 0) from += LOOP;
    const to = from + delta + settle;
    const timeline = controls;
    const resume = playing;
    timeline.pause();
    jump = animate(from, to, {
      duration: Math.min(Math.max(0.6 + Math.abs(to - from) * 0.09, 0.7), 2.2),
      ease: [0.65, 0, 0.35, 1],
      onUpdate: (time) => {
        timeline.time = time;
      },
      onComplete: () => {
        jump = undefined;
        if (resume && playing) timeline.play();
      },
    });
  };

  const actions = {
    playPause: () => {
      stopJump();
      setPlaying(!playing);
    },
    // Rewind to the latest cue and play it again, e.g. to see a retuned spring.
    replay: () => {
      if (!controls) return;
      if (!playing) setPlaying(true);
      jumpTo(currentShape(wrapTime(controls.time)));
    },
    burst: () => fireBurst([0, 0]),
  };

  // ------------------------------------------------------------ pointer

  const toNdc = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      1 - ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2,
    ];
  };

  const fireBurst = (origin: readonly [number, number]) => {
    if (bursts.length >= MAX_BURSTS) bursts.shift();
    bursts.push({
      origin,
      age: 0,
      amplitude: BURST_AMPLITUDE * (settings.calm ? CALM.burst : 1),
      born: wall,
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.target !== canvas) {
      // Over the controls: release the swarm instead of parting it around a cursor it cannot see.
      if (event.pointerType === 'mouse' && hovering) leave();
      return;
    }
    const [x, y] = toNdc(event);
    lastPointer = [x, y];
    if (!hovering && event.pointerType === 'mouse') {
      // Entering: start the push where the pointer is instead of sweeping in from the last exit.
      pointerX.jump(x);
      pointerY.jump(y);
      sprungX.jump(x);
      sprungY.jump(y);
    }
    pointerX.set(x);
    pointerY.set(y);
    if (event.pointerType === 'mouse' || pressed) {
      hovering = true;
      pushTarget.set(1);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.target !== canvas) return;
    const [x, y] = toNdc(event);
    pressed = { x: event.clientX, y: event.clientY };
    lastPointer = [x, y];
    if (event.pointerType !== 'mouse') {
      pointerX.jump(x);
      pointerY.jump(y);
      sprungX.jump(x);
      sprungY.jump(y);
    }
    hovering = true;
    pushTarget.set(1);
  };

  const onPointerUp = (event: PointerEvent) => {
    const start = pressed;
    pressed = undefined;
    if (start && event.target === canvas && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
      fireBurst(toNdc(event));
    }
    if (event.pointerType !== 'mouse') leave();
  };

  const leave = () => {
    hovering = false;
    pushTarget.set(0);
  };

  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') leave();
  };

  const onMotionPreference = () => {
    settings.calm = motion?.matches ?? false;
    refresh('calm');
    applyCalm();
  };

  const applyCalm = () => {
    rebake();
    applyLook();
    applySpeed();
  };

  // ------------------------------------------------------------ frame

  const tick = () => {
    try {
      render();
    } catch (error) {
      // A frame that throws would throw again on every tick: stop once and
      // report it outside Motion's frameloop.
      dispose();
      queueMicrotask(() => {
        throw error;
      });
    }
  };

  const render = () => {
    if (disposed || !gpu || !output || !pipeline) return;
    const dt = Math.min(Math.max(frameData.delta, 0), 50) / 1000;
    clock(gpu).advance(dt);
    wall += dt;

    const time = wrapTime(playhead.get());
    // A scrub or jump is a cut: trails restart instead of ghosting the old shape.
    const step = Math.abs(time - lastTime);
    const cut = Math.min(step, LOOP - step) > TRAIL_CUT;
    lastTime = time;
    const calm = settings.calm;
    const aspect = size[0] / Math.max(1, size[1]);
    const camera = cameraAt(time, aspect, calm ? 0 : 1);
    const segments = activeSegments(time, inFlight);

    // The cursor pattern starts each morph where the pointer was when its cue fired.
    // That origin and the click bursts (wall clock) are the only inputs outside
    // the timeline: a scrub replays every other pattern exactly.
    for (const index of origins.keys()) {
      if (!segments.some((segment) => segment.index === index)) origins.delete(index);
    }
    for (const segment of segments) {
      if (!origins.has(segment.index)) origins.set(segment.index, lastPointer);
    }

    for (let i = bursts.length - 1; i >= 0; i--) {
      const burst = bursts[i]!;
      burst.age = wall - burst.born;
      if (burst.age > BURST_SPREAD + spring.duration) bursts.splice(i, 1);
    }

    sinceGui += dt;
    if (sinceGui >= GUI_REFRESH) {
      sinceGui = 0;
      if (!scrubbing) {
        settings.time = Math.round(time * 100) / 100;
        refresh('time');
      }
      const shape = currentShape(time);
      if (shape !== settings.shape) {
        settings.shape = shape;
        refresh('shape');
      }
    }

    const state = {
      time,
      viewProjection: camera.viewProjection,
      yaw: camera.yaw,
      baseShape: baseShape(time, segments),
      segments,
      pattern: settings.pattern,
      origins,
      bursts,
      pointer: {
        position: [sprungX.get(), sprungY.get()] as const,
        velocity: [sprungX.getVelocity() * aspect, sprungY.getVelocity()] as const,
        strength: push.get() * (calm ? CALM.push : 1),
        radius: pointerRadius,
      },
      // A jump fast-forwards through whole morphs: trails would only ghost them.
      keep: settings.trails && !calm && !cut && !jump ? Math.pow(TRAIL_KEEP, dt * 60) : 0,
    };
    const target = output;
    const chain = pipeline;
    frame(gpu, (currentFrame) => chain.encode(currentFrame, target, state));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of [
      () => {
        if (ticking) cancelFrame(tick);
      },
      () => stopJump(),
      () => controls?.stop(),
      () => unsubscribeResize?.(),
      () => motion?.removeEventListener('change', onMotionPreference),
      () => {
        container?.removeEventListener('pointermove', onPointerMove);
        container?.removeEventListener('pointerdown', onPointerDown);
        container?.removeEventListener('pointerleave', onPointerLeave);
      },
      () => {
        if (typeof window !== 'undefined') window.removeEventListener('pointerup', onPointerUp);
        if (typeof window !== 'undefined') window.removeEventListener('pointercancel', onPointerUp);
      },
      () => {
        for (const value of [sprungX, sprungY, push, pointerX, pointerY, pushTarget, playhead]) value.destroy();
      },
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]) {
      bestEffort(cleanup);
    }
  };

  const initialize = async () => {
    if (disposed) return;
    const nextGpu = await init({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, MAX_DPR] });
    motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    settings.calm = motion?.matches ?? false;
    pipeline = createPipeline(gpu, { count: settings.count });
    rebake();
    applyLook();
    await pipeline.prewarm(output);
    if (disposed) return;

    const chain = pipeline;
    unsubscribeResize = output.onResize(({ width, height, dpr }) => {
      size = [width, height];
      // The push radius in CSS pixels: a sixth of the short side, within finger and cursor sizes.
      pointerRadius = Math.min(Math.max((Math.min(width, height) / dpr) * 0.17, 56), 150);
      chain.resize([width, height], dpr);
    });
    motion?.addEventListener('change', onMotionPreference);
    container?.addEventListener('pointermove', onPointerMove);
    container?.addEventListener('pointerdown', onPointerDown);
    container?.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    gui = createGui(container, settings, actions, controllers, {
      scrub,
      endScrub,
      jumpTo,
      speed: applySpeed,
      preset: () => {
        if (settings.preset !== 'Custom') Object.assign(settings, SPRING_PRESETS[settings.preset]);
        refresh('spring');
        rebake();
      },
      spring: () => {
        settings.preset = 'Custom';
        refresh('preset');
        rebake();
      },
      stagger: rebake,
      count: () => pipeline?.setCount(settings.count),
      look: applyLook,
      calm: applyCalm,
    });

    controls = animate(timelineSequence(playhead), { repeat: Infinity });
    applySpeed();
    // keepAlive: Motion calls tick every frame, after it has advanced the timeline.
    motionFrame.render(tick, true);
    ticking = true;
  };

  function fail(error: unknown): never {
    dispose();
    throw error;
  }

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });

  return { ready, dispose };
}

interface GuiHandlers {
  scrub(time: number): void;
  endScrub(): void;
  jumpTo(shape: number): void;
  speed(): void;
  preset(): void;
  spring(): void;
  stagger(): void;
  count(): void;
  look(): void;
  calm(): void;
}

function createGui(
  container: HTMLElement | undefined,
  settings: Settings,
  actions: { playPause: () => void; replay: () => void; burst: () => void },
  controllers: Partial<Record<string, Controller[]>>,
  on: GuiHandlers,
): GUI {
  if (!container) throw new Error('Spring Choreography needs a GUI container');

  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: 'Spring Choreography', container, width: 250 });
    Object.assign(gui.domElement.style, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
    });
    const keep = (key: string, controller: Controller) => {
      (controllers[key] ??= []).push(controller);
      return controller;
    };

    const timeline = gui.addFolder('Timeline');
    keep('play', timeline.add(actions, 'playPause').name('Pause'));
    keep(
      'time',
      timeline
        .add(settings, 'time', 0, LOOP, 0.01)
        .name('Time')
        .onChange((time: number) => on.scrub(time))
        .onFinishChange(() => on.endScrub()),
    );
    timeline.add(settings, 'speed', 0.1, 3, 0.05).name('Speed').onChange(on.speed);
    keep(
      'shape',
      timeline
        .add(settings, 'shape', Object.fromEntries(SHAPES.map((shape, i) => [shape.label, i])))
        .name('Jump to')
        .onChange((shape: number) => on.jumpTo(shape)),
    );
    timeline.add(actions, 'replay').name('Replay morph');
    timeline.add(actions, 'burst').name('Burst from centre');

    const spring = gui.addFolder('Spring');
    keep('preset', spring.add(settings, 'preset', [...Object.keys(SPRING_PRESETS), 'Custom']).name('Preset').onChange(on.preset));
    keep('spring', spring.add(settings, 'stiffness', 20, 600, 1).name('Stiffness').onChange(on.spring));
    keep('spring', spring.add(settings, 'damping', 1, 60, 0.5).name('Damping').onChange(on.spring));
    keep('spring', spring.add(settings, 'mass', 0.2, 5, 0.05).name('Mass').onChange(on.spring));

    const stagger = gui.addFolder('Stagger');
    stagger
      .add(settings, 'pattern', {
        Auto: 'auto',
        ...Object.fromEntries(Object.entries(PATTERNS).map(([id, pattern]) => [pattern.label, id])),
      })
      .name('Pattern')
      .onChange(on.stagger);
    stagger.add(settings, 'spread', 0, 2.5, 0.05).name('Spread (s)').onChange(on.stagger);
    stagger.add(settings, 'ease', STAGGER_EASES).name('Ease').onChange(on.stagger);
    stagger.close();

    const look = gui.addFolder('Look');
    look.add(settings, 'count', PARTICLE_COUNTS).name('Particles').onChange(on.count);
    look.add(settings, 'colorMode', COLOR_MODES).name('Colour').onChange(on.look);
    look.add(settings, 'streaks', 0, 0.08, 0.002).name('Streaks (s)').onChange(on.look);
    look.add(settings, 'trails').name('Trails');
    look.add(settings, 'bloom').name('Bloom').onChange(on.look);
    look.add(settings, 'exposure', 0.3, 2.5, 0.05).name('Exposure').onChange(on.look);
    keep('calm', look.add(settings, 'calm').name('Calm motion').onChange(on.calm));
    look.close();

    if (container.clientWidth < GUI_OPEN_MIN_WIDTH) gui.close();
    return gui;
  } catch (error) {
    bestEffort(() => gui?.destroy());
    throw error;
  }
}
