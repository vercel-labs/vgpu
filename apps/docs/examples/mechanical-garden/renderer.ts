import GUI, { type Controller } from "lil-gui";
import type { Vec3 } from "math";
import { clock, frameLoop, surface, type Gpu, type Surface } from "vgpu";
import { orbitRig, smoothRig, type OrbitRig } from "vgpu/scene";

import { applyView, cameraRay, followRobot, VIEWS } from "./camera";
import {
  advance,
  clearDestination,
  createColony,
  DEFAULT_PRESET,
  DEFAULT_SEED,
  MAX_ROBOTS,
  PRESETS,
  readStats,
  reset,
  setCount,
  setDestination,
  setPreset,
  step,
  type Colony,
  type ColonyStats,
  type PresetName,
} from "./colony";
import { installInput, isEditTool, type GardenInput, type Tool } from "./input";
import { createPipeline, type BrushOverlay, type GardenPipeline } from "./pipeline";
import { LEG_COUNT } from "./robot";
import { raycast } from "./terrain";
import { COMPACT_WIDTH, createToolbar, type Toolbar } from "./toolbar";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container?: HTMLElement;
}

export interface Settings {
  preset: PresetName;
  robots: number;
  seed: number;
  paused: boolean;
  pace: number;
  tool: Tool;
  radius: number;
  strength: number;
  follow: boolean;
  autoOrbit: boolean;
  debug: boolean;
}

const IDLE_ORBIT_SPEED = 0.05;
const CAMERA_TIME_CONSTANT = 0.12;
const SHORT_HEIGHT = 560;
const GUI_WIDTH = 236;
const STATS_INTERVAL = 0.5;
/** Calm defaults under prefers-reduced-motion (the user can still change both). */
export const REDUCED_PACE = 0.45;
const REDUCED_TIME_SCALE = 0.3;

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let colony: Colony | undefined;
  let pipeline: GardenPipeline | undefined;
  let input: GardenInput | undefined;
  let gui: GUI | undefined;
  let toolbar: Toolbar | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;
  const goal: OrbitRig = orbitRig(VIEWS[DEFAULT_PRESET]);
  const current: OrbitRig = orbitRig(VIEWS[DEFAULT_PRESET]);
  const motion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  let reducedMotion = motion?.matches ?? false;
  let onMotionChange: ((event: MediaQueryListEvent) => void) | undefined;
  // The idle orbit pauses while a pointer is anywhere over the demo, lil-gui panel included.
  const hoverTarget: HTMLElement = container ?? canvas;
  let hovered = false;
  const onPointerEnter = () => {
    hovered = true;
  };
  const onPointerLeave = () => {
    hovered = false;
  };
  // A press must not outlive the window's focus (a dragged-out pointer, an alt-tab mid-sculpt).
  const onWindowBlur = () => input?.cancel();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runCleanups([
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => onMotionChange && motion?.removeEventListener("change", onMotionChange),
      () => hoverTarget.removeEventListener("pointerenter", onPointerEnter),
      () => hoverTarget.removeEventListener("pointerleave", onPointerLeave),
      () => window.removeEventListener("blur", onWindowBlur),
      () => input?.dispose(),
      () => toolbar?.dispose(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]);
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the render, resize or initialization error.
    }
    throw error;
  }

  function guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      return fail(error);
    }
  }

  function pixelRatio(): number {
    return output ? output.size[1] / Math.max(1, canvas.clientHeight) : 1;
  }

  function aspect(): number {
    return output && output.size[1] > 0 ? output.size[0] / output.size[1] : 16 / 9;
  }

  const rayOrigin: Vec3 = [0, 0, 0];
  const rayDirection: Vec3 = [0, 0, 0];
  const rayHit: Vec3 = [0, 0, 0];
  function pick(clientX: number, clientY: number, out: [number, number]): boolean {
    if (!pipeline || !colony || !output) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    cameraRay(pipeline.camera.pose, pipeline.lens, output.size[0] / output.size[1], ndcX, ndcY, rayOrigin, rayDirection);
    if (!raycast(colony.terrain, rayOrigin, rayDirection, rayHit)) return false;
    out[0] = rayHit[0];
    out[1] = rayHit[2];
    return true;
  }

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, 2] });
    const garden = createColony({ seed: DEFAULT_SEED, count: PRESETS[DEFAULT_PRESET].count });
    colony = garden;
    pipeline = createPipeline(gpu, garden, output.size);
    const settings: Settings = {
      preset: DEFAULT_PRESET,
      robots: garden.count,
      seed: DEFAULT_SEED,
      paused: false,
      pace: reducedMotion ? REDUCED_PACE : 1,
      tool: "orbit",
      radius: garden.brush.radius,
      strength: garden.brush.strength,
      follow: false,
      autoOrbit: !reducedMotion,
      debug: false,
    };
    garden.pace = settings.pace;
    /** The brush for the next fixed step: a press of the elevate or lower tool (pointer or Enter/Space). */
    const beforeStep = () => {
      const pressed = input?.cursor.pressed ?? false;
      garden.brush.mode = settings.tool === "lower" ? "lower" : "elevate";
      garden.brush.active = (settings.tool === "elevate" || settings.tool === "lower") && pressed;
      if (input) {
        garden.brush.x = input.cursor.x;
        garden.brush.z = input.cursor.z;
      }
      garden.brush.radius = settings.radius;
      garden.brush.strength = settings.strength;
    };

    gui = new GUI({ title: "Settings", container, width: GUI_WIDTH });
    const short = (container?.clientHeight ?? SHORT_HEIGHT) < SHORT_HEIGHT;
    const controls = configureGui(gui, settings, short, {
      preset: (preset) => guard(() => {
        setPreset(garden, preset);
        settings.robots = garden.count;
        settings.follow = preset === "close-up";
        applyView(goal, preset, aspect());
        controls.sync();
      }),
      robots: (count) => guard(() => setCount(garden, count)),
      reset: () => guard(() => {
        reset(garden, settings.seed, garden.count);
        input?.cancel();
        controls.sync();
      }),
      pause: (paused) => {
        garden.paused = paused;
      },
      step: () => guard(() => {
        settings.paused = true;
        garden.paused = true;
        beforeStep();
        step(garden);
        controls.sync();
      }),
      pace: (pace) => {
        garden.pace = pace;
      },
      home: () => applyView(goal, settings.preset, aspect()),
    });
    // The same breakpoint docks the tool bar to the bottom, so the two never share the top edge.
    if ((container?.clientWidth ?? COMPACT_WIDTH) < COMPACT_WIDTH) gui.close();

    /**
     * Tools are exclusive: switching drops any press in flight, and an edit tool holds the camera
     * where it is (idle orbit and follow pause until Orbit is picked again).
     */
    const setTool = (tool: Tool) => {
      if (tool === settings.tool) return;
      settings.tool = tool;
      input?.cancel();
      toolbar?.setTool(tool);
      if (isEditTool(tool)) copyRig(goal, current);
      controls.editing(isEditTool(tool));
    };

    input = installInput(canvas, goal, {
      tool: () => settings.tool,
      pick,
      onDestination: (x, z) => guard(() => setDestination(garden, x, z)),
      onTool: setTool,
      onPause: () => {
        settings.paused = !settings.paused;
        garden.paused = settings.paused;
        controls.sync();
      },
      onStep: controls.actions.step,
    });
    if (container) {
      const panel = gui.domElement;
      const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
      toolbar = createToolbar(container, {
        tool: settings.tool,
        radius: settings.radius,
        strength: settings.strength,
        touch,
        before: gui.domElement,
        onTool: setTool,
        onRadius: (radius) => {
          settings.radius = radius;
        },
        onStrength: (strength) => {
          settings.strength = strength;
        },
        onClearDestination: () => guard(() => clearDestination(garden)),
        // Docked at the bottom, Settings scrolls in the space above the bar instead of covering it.
        onDock: (height) => {
          panel.style.maxHeight = height === null ? "calc(100% - 16px)" : `calc(100% - ${height + 24}px)`;
        },
      });
    }
    window.addEventListener("blur", onWindowBlur);
    hoverTarget.addEventListener("pointerenter", onPointerEnter);
    hoverTarget.addEventListener("pointerleave", onPointerLeave);
    // Reduced motion sets calm defaults; a value the user changed is theirs and survives.
    onMotionChange = (event) => {
      reducedMotion = event.matches;
      if (!controls.touched.has("autoOrbit")) settings.autoOrbit = !reducedMotion;
      if (!controls.touched.has("pace")) {
        settings.pace = reducedMotion ? REDUCED_PACE : 1;
        garden.pace = settings.pace;
      }
      controls.sync();
    };
    motion?.addEventListener("change", onMotionChange);
    // The first measured size frames the opening view for its aspect (and snaps the camera there);
    // later resizes keep wherever the user put the camera.
    let framed = false;
    unsubscribeResize = output.onResize(() =>
      guard(() => {
        if (!output || !pipeline) return;
        pipeline.resize(output.size, pixelRatio());
        toolbar?.layout(container?.clientWidth ?? canvas.clientWidth);
        if (!framed && output.size[0] > 0 && output.size[1] > 0) {
          framed = true;
          applyView(goal, settings.preset, aspect());
          applyView(current, settings.preset, aspect());
        }
      }),
    );

    const ticks = clock(gpu);
    const brush: BrushOverlay = [0, 0, 1, 0];
    const stats: ColonyStats = { robots: 0, swinging: 0, meanSpeed: 0, worstResidual: 0, rejected: 0 };
    let renderTime = 0;
    let statsAge = STATS_INTERVAL;
    const uploads: UploadRates = { instances: 0, terrainBytes: 0, rigRows: 0 };
    let terrainTotal = pipeline.counters.terrainBytes;
    let rigTotal = pipeline.counters.rigRows;
    let simMs = 0;
    loop = frameLoop(gpu, (currentFrame) => {
      guard(() => {
        if (disposed || !output || !pipeline || !input || !gui) return;
        const dt = Math.min(ticks.deltaTime, 0.1);
        const { cursor } = input;

        const started = performance.now();
        const ran = advance(garden, dt, beforeStep);
        if (ran > 0) simMs += ((performance.now() - started) / ran - simMs) * 0.1;

        // Camera: in the orbit tool, follow robot 0 and idle-orbit when nobody is interacting; an
        // edit tool holds it still. Then glide.
        const editing = isEditTool(settings.tool);
        const guiFocused = gui.domElement.matches(":focus-within");
        if (!editing && settings.follow && garden.count > 0) followRobot(goal, garden.robots[0]!);
        if (!editing && settings.autoOrbit && !hovered && !input.engaged && !guiFocused && document.activeElement !== canvas) {
          goal.yaw += dt * IDLE_ORBIT_SPEED;
        }
        smoothRig(current, goal, dt, { timeConstant: reducedMotion ? 0.02 : CAMERA_TIME_CONSTANT });
        pipeline.updateCamera(current);

        const aiming = editing && (cursor.visible || (toolbar?.adjusting ?? false));
        brush[0] = cursor.x;
        brush[1] = cursor.z;
        brush[2] = settings.radius;
        // Style: off, destination marker (2), or the sculpt direction of the tool.
        brush[3] = !aiming ? 0 : settings.tool === "destination" ? 2 : settings.tool === "lower" ? -1 : 1;
        if (brush[3] === 2) brush[2] = 0.3;
        toolbar?.setDestination(garden.destination.active);
        toolbar?.setPaused(settings.paused);
        renderTime += dt * (reducedMotion ? REDUCED_TIME_SCALE : 1);
        pipeline.render(currentFrame, output, { time: renderTime, brush, debug: settings.debug });

        statsAge += dt;
        if (statsAge >= STATS_INTERVAL) {
          const interval = statsAge;
          statsAge = 0;
          readStats(garden, stats);
          // Rates over the readout interval (measured on the same clamped dt).
          const { counters } = pipeline;
          uploads.instances = counters.instances;
          uploads.terrainBytes = (counters.terrainBytes - terrainTotal) / interval;
          uploads.rigRows = (counters.rigRows - rigTotal) / interval;
          terrainTotal = counters.terrainBytes;
          rigTotal = counters.rigRows;
          controls.stats(stats, simMs, garden, uploads);
        }
      });
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

function copyRig(out: OrbitRig, rig: OrbitRig): void {
  out.target.set(rig.target);
  out.pan.set(rig.pan);
  out.yaw = rig.yaw;
  out.pitch = rig.pitch;
  out.distance = rig.distance;
}

/** Upload readouts: the last frame's instance count, and per-second terrain bytes and robot part rows. */
export interface UploadRates {
  instances: number;
  terrainBytes: number;
  rigRows: number;
}

export interface GuiActions {
  preset(preset: PresetName): void;
  robots(count: number): void;
  reset(): void;
  pause(paused: boolean): void;
  step(): void;
  pace(pace: number): void;
  home(): void;
}

/**
 * lil-gui holds the advanced and debug settings only; the tools live in the tool bar. `touched`
 * records settings the user changed (reduced motion leaves those alone); `editing` greys out the
 * camera options an edit tool suspends; `stats` refreshes the read-only counters.
 */
export function configureGui(
  gui: GUI,
  settings: Settings,
  compact: boolean,
  handlers: GuiActions,
): {
  readonly touched: Set<keyof Settings>;
  readonly actions: { step(): void };
  sync(): void;
  editing(editing: boolean): void;
  stats(stats: ColonyStats, simMs: number, colony: Colony, uploads: UploadRates): void;
} {
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    zIndex: "10",
    maxHeight: "calc(100% - 16px)",
    overflowY: "auto",
  });
  const touched = new Set<keyof Settings>();
  const touch = (key: keyof Settings) => () => touched.add(key);
  const controllers: Controller[] = [];
  const keep = <T extends Controller>(controller: T) => (controllers.push(controller), controller);

  const scene = gui.addFolder("Scene");
  keep(scene.add(settings, "preset", Object.keys(PRESETS)).name("preset")).onChange(handlers.preset);
  keep(scene.add(settings, "robots", 1, MAX_ROBOTS, 1).name("robots")).onFinishChange(handlers.robots);
  keep(scene.add(settings, "paused").name("paused")).onChange(handlers.pause);
  const actions = {
    step: handlers.step,
    reset: handlers.reset,
    home: handlers.home,
  };
  scene.add(actions, "step").name("step once");
  keep(scene.add(settings, "pace", 0.1, 1, 0.05).name("pace"))
    .onChange((pace: number) => {
      touched.add("pace");
      handlers.pace(pace);
    });
  keep(scene.add(settings, "seed", 1, 9999, 1).name("seed"));
  scene.add(actions, "reset").name("reset to seed");

  const view = gui.addFolder("Camera");
  const follow = keep(view.add(settings, "follow").name("follow robot 1"));
  const idleOrbit = keep(view.add(settings, "autoOrbit").name("idle orbit")).onChange(touch("autoOrbit"));
  view.add(actions, "home").name("reset view");

  const debug = gui.addFolder("Debug");
  keep(debug.add(settings, "debug").name("targets and IK"));

  const readout = { swinging: "", speed: "", residual: "", rejected: "", sim: "", dropped: "", instances: "", terrain: "", rig: "" };
  const statsFolder = gui.addFolder("Stats");
  const readouts = [
    statsFolder.add(readout, "swinging").name("feet in swing"),
    statsFolder.add(readout, "speed").name("mean speed"),
    // The planted legs' FABRIK residual against their clamped in-plane goal: how well the solver
    // met the goal it was given, not the distance from the requested world foot to the ground
    // (out-of-reach goals are clamped first, and rejected solves are counted separately).
    statsFolder.add(readout, "residual").name("planted IK residual"),
    statsFolder.add(readout, "rejected").name("rejected solves"),
    statsFolder.add(readout, "sim").name("simulation (CPU)"),
    statsFolder.add(readout, "dropped").name("dropped steps"),
    // Instances in the last colour pass (robot parts and plinth); terrain vertex bytes and
    // robot part rows sent to the GPU per second. Both uploads are change-tracked: a paused,
    // unsculpted garden uploads nothing.
    statsFolder.add(readout, "instances").name("instances drawn"),
    statsFolder.add(readout, "terrain").name("terrain upload"),
    statsFolder.add(readout, "rig").name("robot parts upload"),
  ];
  for (const controller of readouts) controller.disable();

  view.close();
  debug.close();
  statsFolder.close();
  // Short frames (the gallery's 16:9 frame) start with every folder closed: four headers, no cover.
  if (compact) scene.close();

  return {
    touched,
    actions,
    sync() {
      for (const controller of controllers) controller.updateDisplay();
    },
    editing(editing) {
      follow.enable(!editing);
      idleOrbit.enable(!editing);
    },
    stats(stats, simMs, colony, uploads) {
      readout.swinging = `${stats.swinging} of ${stats.robots * LEG_COUNT}`;
      // The scene has no physical scale: distances are world units (a femur is 0.3, the tile 15 across).
      readout.speed = `${stats.meanSpeed.toFixed(2)} units/s`;
      readout.residual = `${stats.worstResidual.toExponential(1)} units`;
      readout.rejected = `${stats.rejected}`;
      readout.sim = `${simMs.toFixed(2)} ms / step`;
      readout.dropped = `${colony.dropped}`;
      readout.instances = `${uploads.instances}`;
      readout.terrain = `${(uploads.terrainBytes / 1024).toFixed(1)} KB/s`;
      readout.rig = `${Math.round(uploads.rigRows)} rows/s`;
      for (const controller of readouts) controller.updateDisplay();
    },
  };
}

function runCleanups(cleanups: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}
