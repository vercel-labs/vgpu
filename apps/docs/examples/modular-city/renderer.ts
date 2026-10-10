import GUI, { type Controller } from "lil-gui";
import { clock, frameLoop, surface, type Gpu, type Surface } from "vgpu";
import { orbitRig, smoothRig, type OrbitRig } from "vgpu/scene";

import { createCity, LIFT_LIMIT, OFFSET_LIMIT, type City } from "./city";
import { POPULATIONS, SWATCHES } from "./layout";
import { installOrbitInput, type OrbitInput, type TapEvent } from "./orbit-input";
import { PickQueue, pickRadius, type PickRequest } from "./picking";
import { createPipeline, HOME_VIEW, type CityPipeline } from "./pipeline";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container?: HTMLElement;
}

interface Settings {
  population: number;
  neighborhood: number;
  building: string;
  buildings: number;
  swatch: string;
  x: number;
  z: number;
  lift: number;
  autoOrbit: boolean;
  tiltShift: number;
}

const IDLE_ORBIT_SPEED = 0.045;
const CAMERA_TIME_CONSTANT = 0.12;
const NARROW_WIDTH = 640;
const SHORT_HEIGHT = 640;
const GUI_WIDTH = 248;
// The home view fits the board at this visible aspect; narrower views dolly out, up to MAX_FIT.
const FIT_ASPECT = 1.28;
const MAX_FIT = 2.4;

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let city: City | undefined;
  let pipeline: CityPipeline | undefined;
  let input: OrbitInput | undefined;
  let gui: GUI | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let syncGui: (() => void) | undefined;
  const picks = new PickQueue();
  const goal: OrbitRig = orbitRig(HOME_VIEW);
  const current: OrbitRig = orbitRig(HOME_VIEW);
  const motion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  let reducedMotion = motion?.matches ?? false;
  const onMotionChange = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
  };
  // The idle orbit pauses while a pointer is anywhere over the demo, lil-gui panel included.
  const hoverTarget: HTMLElement = container ?? canvas;
  let hovered = false;
  const onPointerEnter = () => {
    hovered = true;
  };
  const onPointerLeave = () => {
    hovered = false;
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runCleanups([
      () => picks.dispose(),
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => motion?.removeEventListener("change", onMotionChange),
      () => hoverTarget.removeEventListener("pointerenter", onPointerEnter),
      () => hoverTarget.removeEventListener("pointerleave", onPointerLeave),
      () => input?.dispose(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]);
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the render, resize, readback, or initialization error.
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

  function resize(): void {
    guard(() => {
      if (!output || !pipeline) return;
      pipeline.resize(output.size, pixelRatio());
    });
  }

  function tap(event: TapEvent): void {
    if (!output || !city) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const point = {
      x: ((event.clientX - rect.left) * output.size[0]) / rect.width,
      y: ((event.clientY - rect.top) * output.size[1]) / rect.height,
    };
    picks.request(point, pickRadius(event.pointerType, pixelRatio()), city.generation);
  }

  // The pick target is read once, after the frame that rendered it completed on the GPU.
  function readPick(done: Promise<void>, request: PickRequest): void {
    done
      .then(() => (disposed ? undefined : pipeline!.readPick()))
      .then(
        (bytes) => {
          if (!bytes || disposed || !city) return;
          const code = picks.finish(request, bytes, city.generation);
          if (code === undefined) return;
          city.select(code);
          syncGui?.();
        },
        (error: unknown) => {
          picks.abandon(request);
          if (disposed) return;
          queueMicrotask(() => fail(error));
        }
      );
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
    city = createCity();
    pipeline = createPipeline(gpu, city, output.size);
    input = installOrbitInput(canvas, goal, { onTap: (event) => guard(() => tap(event)) });
    motion?.addEventListener("change", onMotionChange);
    hoverTarget.addEventListener("pointerenter", onPointerEnter);
    hoverTarget.addEventListener("pointerleave", onPointerLeave);
    gui = new GUI({ title: "City", container, width: GUI_WIDTH });
    const short = (container?.clientHeight ?? SHORT_HEIGHT) < SHORT_HEIGHT;
    const controls = configureGui(gui, city, pipeline, goal, (action) => guard(action), short);
    syncGui = controls.sync;
    if ((container?.clientWidth ?? NARROW_WIDTH) < NARROW_WIDTH) gui.close();
    unsubscribeResize = output.onResize(resize);

    const ticks = clock(gpu);
    const { settings } = controls;
    const framed: OrbitRig = orbitRig(HOME_VIEW);
    const shown = { shift: 0, fit: 1 };
    let firstFrame = true;
    loop = frameLoop(gpu, (currentFrame) => {
      guard(() => {
        if (disposed || !output || !pipeline || !city || !input || !gui) return;
        const dt = Math.min(ticks.deltaTime, 0.1);
        const guiFocused = gui.domElement.matches(":focus-within");
        if (settings.autoOrbit && !reducedMotion && !hovered && !input.engaged && !guiFocused) {
          goal.yaw += dt * IDLE_ORBIT_SPEED;
        }
        smoothRig(current, goal, dt, { timeConstant: reducedMotion ? 0 : CAMERA_TIME_CONSTANT });
        // The open panel covers the right edge of landscape frames: frame the city in what is left.
        const covered = canvas.clientWidth >= NARROW_WIDTH && !gui._closed ? GUI_WIDTH + 8 : 0;
        const wanted = framing(canvas.clientWidth, canvas.clientHeight, covered);
        const blend = firstFrame || reducedMotion ? 1 : 1 - Math.exp(-dt / CAMERA_TIME_CONSTANT);
        firstFrame = false;
        shown.shift += (wanted.shift - shown.shift) * blend;
        shown.fit += (wanted.fit - shown.fit) * blend;
        framed.target.set(current.target);
        framed.pan.set(current.pan);
        framed.yaw = current.yaw;
        framed.pitch = current.pitch;
        framed.distance = current.distance * shown.fit;
        pipeline.updateCamera(framed, shown.shift);
        const request = picks.begin();
        pipeline.render(currentFrame, output, { pick: request });
        if (request) readPick(currentFrame.done, request);
      });
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

/**
 * lil-gui is the keyboard path for everything the pointer does: choose a neighborhood, step
 * through its buildings, recolor, delete or add one, nudge the neighborhood, and reset.
 * `sync` refreshes every display after a pointer pick.
 */
export function configureGui(
  gui: GUI,
  city: City,
  pipeline: CityPipeline,
  goal: OrbitRig,
  run: (action: () => void) => void,
  compact = false
): { readonly settings: Settings; readonly sync: () => void } {
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    zIndex: "10",
    maxHeight: "calc(100% - 16px)",
    overflowY: "auto",
  });
  const settings: Settings = {
    population: city.plan.population,
    neighborhood: city.selection.neighborhood,
    building: "",
    buildings: 0,
    swatch: "",
    x: 0,
    z: 0,
    lift: 0,
    autoOrbit: true,
    tiltShift: pipeline.lighting.tiltShift,
  };
  // Names depend only on the district map, so they survive a population change.
  const neighborhoodNames = Object.fromEntries(
    city.neighborhoods.map(({ plan }) => [`${plan.index + 1}. ${plan.name}`, plan.index])
  );

  const selection = gui.addFolder("Selection");
  const neighborhood = selection
    .add(settings, "neighborhood", neighborhoodNames)
    .name("neighborhood")
    .onChange((index: number) => run(() => {
      city.selectNeighborhood(index);
      sync();
    }));
  const building = selection.add(settings, "building").name("building").disable();
  const actions = {
    previous: () => run(() => {
      city.step(-1);
      sync();
    }),
    next: () => run(() => {
      city.step(1);
      sync();
    }),
    recolor: () => run(() => {
      city.recolor(city.selection.building);
      sync();
    }),
    // Deleting moves the selection to the next building in the neighborhood, so the focused delete
    // button stays enabled for the next press; an emptied neighborhood hands focus to "add building".
    remove: () => run(() => {
      const ids = city.buildingIds(city.selection.neighborhood);
      const index = ids.indexOf(city.selection.building);
      if (!city.remove(city.selection.building)) return;
      const rest = ids.filter((_, position) => position !== index);
      if (rest.length > 0) city.select(rest[Math.min(index, rest.length - 1)]!);
      sync();
      if (rest.length === 0) focusButton(add);
    }),
    // Filling the last lot disables "add building", so focus moves to "delete building".
    add: () => run(() => {
      city.add(city.selection.neighborhood);
      sync();
      if (!vacant()) focusButton(remove);
    }),
    reset: () => run(() => {
      city.rebuild(settings.population);
      sync();
    }),
    home: () => run(() => {
      goal.target.set(HOME_VIEW.target);
      goal.pan.fill(0);
      goal.yaw = HOME_VIEW.yaw;
      goal.pitch = HOME_VIEW.pitch;
      goal.distance = HOME_VIEW.distance;
    }),
  };
  selection.add(actions, "previous").name("previous building");
  selection.add(actions, "next").name("next building");
  const swatch = selection.add(settings, "swatch").name("color").disable();
  const recolor = selection.add(actions, "recolor").name("recolor");
  const remove = selection.add(actions, "remove").name("delete building");
  const add = selection.add(actions, "add").name("add building");

  const offset = gui.addFolder("Neighborhood offset");
  const move = (key: "x" | "z" | "lift") => (value: number) =>
    run(() => city.moveNeighborhood(city.selection.neighborhood, { [key]: value }));
  const x = offset.add(settings, "x", -OFFSET_LIMIT, OFFSET_LIMIT, 0.05).name("x").onChange(move("x"));
  const z = offset.add(settings, "z", -OFFSET_LIMIT, OFFSET_LIMIT, 0.05).name("z").onChange(move("z"));
  const lift = offset.add(settings, "lift", 0, LIFT_LIMIT, 0.05).name("lift").onChange(move("lift"));

  const layout = gui.addFolder("Layout");
  layout
    .add(settings, "population", [...POPULATIONS])
    .name("population")
    .onChange(actions.reset);
  const buildings = layout.add(settings, "buildings").name("buildings").disable();
  layout.add(actions, "reset").name("reset layout");

  const view = gui.addFolder("View");
  view.add(settings, "autoOrbit").name("idle orbit");
  view
    .add(settings, "tiltShift", 0, 1.5, 0.05)
    .name("tilt-shift")
    .onChange((value: number) => {
      pipeline.lighting.tiltShift = value;
    });
  view.add(actions, "home").name("reset view");
  // Short frames (the gallery card) keep the editing folders open and fold the rest.
  if (compact) {
    layout.close();
    view.close();
  }

  const enable = (controller: Controller, enabled: boolean) => controller.enable(enabled);
  // lil-gui disables a button in place, which drops its keyboard focus to the page.
  const focusButton = (controller: Controller) => controller.domElement.querySelector("button")?.focus();
  const vacant = () => {
    const hood = city.neighborhoods[city.selection.neighborhood]!;
    return hood.occupied.size < hood.plan.lots.length;
  };

  function sync(): void {
    const { selection: selected } = city;
    const record = city.building(selected.building);
    const hood = city.neighborhoods[selected.neighborhood]!;
    settings.neighborhood = selected.neighborhood;
    settings.building = record ? `#${record.id} ${record.kind}` : "none";
    settings.swatch = record ? SWATCHES[record.swatch]!.name : "–";
    settings.buildings = city.buildingCount();
    settings.x = hood.offset.x;
    settings.z = hood.offset.z;
    settings.lift = hood.offset.lift;
    for (const controller of [neighborhood, building, swatch, x, z, lift, buildings]) controller.updateDisplay();
    enable(recolor, Boolean(record));
    enable(remove, Boolean(record));
    enable(add, vacant());
  }

  sync();
  return { settings, sync };
}

/**
 * Lens shift (NDC) and distance factor that keep the whole board inside the uncovered part of a
 * `width`×`height` CSS-px canvas whose right `covered` pixels sit under the panel.
 */
export function framing(width: number, height: number, covered: number): { shift: number; fit: number } {
  const visible = Math.max(1, width - covered);
  return {
    shift: width > 0 ? -covered / width : 0,
    fit: Math.min(MAX_FIT, Math.max(1, (FIT_ASPECT * Math.max(1, height)) / visible)),
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
