// Motion owns the frame. Its frameloop runs the drag, the inertia coast and
// the hover/press springs, writes the orb's transform in `render`, and then
// calls this renderer in `postRender`. There the renderer reads the orb's
// on-screen rect and scale, turns them into a swept segment, a velocity and
// wall contacts, advances the vgpu clock by Motion's delta, steps the fluid
// and draws the glass lens in the same browser frame. React never re-renders
// per frame: the store only carries settings.

import GUI from 'lil-gui';
import { cancelFrame, frame as motionFrame, frameData } from 'motion';
import { clock, frame, init, surface, type Gpu, type Surface } from 'vgpu';

import type { Quality } from './fluid';
import { createOrbTracker, type OrbTracker, type TrackedOrb } from './orb-tracker';
import { DEFAULT_SETTINGS, type OrbStore, type RectLike, type ThrowSettings } from './orb-store';
import {
  createPipeline,
  DEFAULT_TUNING,
  FLUID_DAMPING,
  INK,
  PALETTE_NAMES,
  type PaletteName,
  type Pipeline,
  type Scene,
} from './pipeline';
import { createWake } from './wake';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Hosts the lil-gui panel and receives pointer input; defaults to the canvas parent. */
  readonly container?: HTMLElement;
  readonly store: OrbStore;
}

interface Settings extends ThrowSettings {
  autoplay: boolean;
  viscosity: number;
  dissipation: number;
  vorticity: number;
  palette: PaletteName;
  quality: Quality;
  refraction: number;
  dispersion: number;
}

type Vec2 = readonly [number, number];

const MAX_DPR = 2;
const GUI_OPEN_MIN_WIDTH = 1440;
const GUI_WIDTH = 230;
/** Closed, the panel shrinks to its title: the orb often rests against the top wall. */
const GUI_CLOSED_WIDTH = 150;
/** And it turns see-through while the orb sits under it. */
const GUI_OVER_ORB_OPACITY = 0.35;
/** "Clear the ink" fades the dye and calms the fluid for this long. */
const DRAIN_SECONDS = 0.7;

// Idle choreography.
const RESUME_AFTER = 6;
const FIRST_FLICK = 0.9;
const FLICK_EVERY = 3.4;
const REDUCED_FLICK_EVERY = 5;
const REST_SPEED = 8;
const REST_FOR = 0.35;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const FIRST_ANGLE = -2.75;

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Teardown must run to completion even when one step throws.
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Whether the round orb inscribed in `orb` reaches into `rect`. */
export function circleMeetsRect(orb: RectLike, rect: RectLike): boolean {
  const radius = orb.width / 2;
  const cx = orb.left + radius;
  const cy = orb.top + orb.height / 2;
  const dx = cx - clamp(cx, rect.left, rect.left + rect.width);
  const dy = cy - clamp(cy, rect.top, rect.top + rect.height);
  return dx * dx + dy * dy < radius * radius;
}

/** Distance from `from` along the unit `direction` until the orb touches a wall. */
export function distanceToWall(from: Vec2, direction: Vec2, radius: number, view: Vec2): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 2; axis++) {
    const d = direction[axis]!;
    if (Math.abs(d) < 1e-6) continue;
    const wall = d > 0 ? view[axis]! - radius : radius;
    distance = Math.min(distance, (wall - from[axis]!) / d);
  }
  return Math.max(0, distance);
}

/**
 * The idle flick: an inertia velocity whose coast ends past the wall ahead
 * (`reach` > 1), so the orb arrives with speed left and splashes, or stops
 * short of it (`reach` < 1) under reduced motion.
 */
export function flickVelocity(
  orb: TrackedOrb,
  view: Vec2,
  angle: number,
  power: number,
  reach: number,
): [number, number] {
  let direction: Vec2 = [Math.cos(angle), Math.sin(angle)];
  let distance = distanceToWall(orb.center, direction, orb.radius, view);
  // Too close to that wall for a proper throw: go the other way.
  if (distance < Math.min(view[0], view[1]) * 0.35) {
    const flipped: Vec2 = [-direction[0], -direction[1]];
    const across = distanceToWall(orb.center, flipped, orb.radius, view);
    if (across > distance) {
      direction = flipped;
      distance = across;
    }
  }
  const coast = Math.max(power, 0.05);
  const speed = clamp((distance * reach) / coast, reach > 1 ? 900 : 200, 3200);
  const velocity: [number, number] = [direction[0] * speed, direction[1] * speed];
  // Each axis coasts on its own, so a throw past the wall ahead would usually
  // carry the other axis into its wall too and park the orb in a corner: the
  // axis that reaches its wall later stops short of it.
  const room = [0, 1].map((axis) => {
    const d = direction[axis]!;
    const wall = d > 0 ? view[axis]! - orb.radius : orb.radius;
    return Math.abs(d) < 1e-6 ? Number.POSITIVE_INFINITY : Math.max(0, (wall - orb.center[axis]!) / d);
  });
  const later = room[0]! > room[1]! ? 0 : 1;
  const space = room[later]! * Math.abs(direction[later]!);
  if (Math.abs(velocity[later]) * coast > space * 0.8) {
    velocity[later] = (Math.sign(velocity[later]) * space * 0.8) / coast;
  }
  return velocity;
}

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined, store }: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let pipeline: Pipeline | undefined;
  let gui: GUI | undefined;
  let motion: MediaQueryList | undefined;
  let ticking = false;
  let pendingSize: Vec2 | null = null;
  const tracker: OrbTracker = createOrbTracker();
  const wake = createWake();

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...pickThrow(store.getState()),
    ...DEFAULT_TUNING,
    autoplay: true,
  };

  let reducedMotion = false;
  let drainFor = 0;
  let viewSize: Vec2 = [0, 0];
  let panelOverOrb = false;

  // Idle: flicks the orb while nobody interacts, pauses for RESUME_AFTER
  // seconds after input, and holds while a press, a hovering mouse or keyboard
  // focus is inside the demo.
  let quietFor = RESUME_AFTER;
  let nextFlickIn = FIRST_FLICK;
  let restFor = 0;
  let flicks = 0;
  let pressed = false;
  let hovering = false;

  const interact = () => {
    quietFor = 0;
  };
  const onPointerDown = () => {
    pressed = true;
    interact();
  };
  const onPointerUp = () => {
    if (pressed) interact();
    pressed = false;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') hovering = true;
    interact();
  };
  const onPointerLeave = () => {
    hovering = false;
  };
  const onMotionPreference = () => {
    reducedMotion = motion?.matches ?? false;
    store.setReduced(reducedMotion);
  };

  const focusedElement = (): Element | null => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active && active !== document.body && container?.contains(active) ? active : null;
  };

  // Golden-angle turns spread the flicks around the tank; the reach varies so
  // some throws arrive hard and some only just splash.
  const flick = (orb: TrackedOrb, fullReach: boolean) => {
    flicks++;
    const reach = reducedMotion ? 0.6 : fullReach ? 3 : 2.1 + ((flicks * 0.618) % 1) * 1.1;
    const [vx, vy] = flickVelocity(orb, viewSize, FIRST_ANGLE + flicks * GOLDEN_ANGLE, settings.power, reach);
    store.handle()?.flick(vx, vy);
  };

  const idle = (dt: number, orb: TrackedOrb) => {
    const { interaction } = store;
    const keyboardFocus = focusedElement()?.matches(':focus-visible') ?? false;
    const held = pressed || hovering || keyboardFocus || interaction.pressed || interaction.dragging || interaction.hovered;
    if (held) quietFor = 0;
    else quietFor += dt;
    restFor = orb.speed < REST_SPEED ? restFor + dt : 0;
    nextFlickIn -= dt;
    if (!settings.autoplay || held || quietFor < RESUME_AFTER) return;
    if (nextFlickIn > 0 || restFor < REST_FOR) return;
    nextFlickIn = reducedMotion ? REDUCED_FLICK_EVERY : FLICK_EVERY;
    flick(orb, false);
  };

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
    const dt = clamp(frameData.delta, 0, 50) / 1000;
    clock(gpu).advance(dt);

    if (pendingSize) {
      pipeline.resize(pendingSize);
      pendingSize = null;
      tracker.reset();
    }

    const handle = store.handle();
    const canvasRect = canvas.getBoundingClientRect();
    const orbRect = handle?.element?.getBoundingClientRect();
    const boundsRect = handle?.bounds?.getBoundingClientRect();
    if (canvasRect.width < 1 || canvasRect.height < 1) return;
    viewSize = [canvasRect.width, canvasRect.height];
    const visible = !!handle && !!orbRect && !!boundsRect && orbRect.width >= 1 && boundsRect.width >= 1;
    const orb = visible
      ? tracker.update({ orb: orbRect, bounds: boundsRect, canvas: canvasRect, scale: handle.scale.get() }, dt)
      : null;

    if (orb) idle(dt, orb);
    if (gui) {
      const covering = !!orbRect && gui._closed && circleMeetsRect(orbRect, gui.domElement.getBoundingClientRect());
      if (covering !== panelOverOrb) {
        panelOverOrb = covering;
        gui.domElement.style.opacity = covering ? String(GUI_OVER_ORB_OPACITY) : '';
      }
    }
    const stir = wake.update({ orb, dt, ripples: store.takeRipples(), gain: reducedMotion ? 0.5 : 1 });
    drainFor = Math.max(0, drainFor - dt);
    const drain = drainFor > 0 ? 1 : 0;

    const scene: Scene = {
      dt,
      view: viewSize,
      orb: stir.orb,
      splash: stir.splash,
      palette: settings.palette,
      phase: stir.phase,
      ink: drain ? 0 : INK,
      drag: stir.drag,
      params: {
        viscosity: settings.viscosity,
        vorticity: settings.vorticity,
        dissipation: settings.dissipation + drain * 7,
        damping: FLUID_DAMPING + drain * 4,
      },
      look: { refraction: settings.refraction, dispersion: settings.dispersion },
    };
    const target = output;
    const chain = pipeline;
    frame(gpu, (currentFrame) => {
      chain.simulate(currentFrame, scene);
      chain.draw(currentFrame, target, scene);
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of [
      () => {
        if (ticking) cancelFrame(tick);
      },
      () => motion?.removeEventListener('change', onMotionPreference),
      () => {
        container?.removeEventListener('pointerdown', onPointerDown);
        container?.removeEventListener('pointermove', onPointerMove);
        container?.removeEventListener('pointerleave', onPointerLeave);
        container?.removeEventListener('keydown', interact);
        container?.removeEventListener('wheel', interact);
      },
      () => {
        if (typeof window !== 'undefined') window.removeEventListener('pointerup', onPointerUp);
        if (typeof window !== 'undefined') window.removeEventListener('pointercancel', onPointerUp);
      },
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]) {
      bestEffort(cleanup);
    }
  };

  const initialize = async () => {
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, MAX_DPR] });
    motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    reducedMotion = motion?.matches ?? false;
    store.setReduced(reducedMotion);
    pipeline = createPipeline(gpu, { size: output.size, quality: settings.quality });
    await pipeline.prewarm(output);
    if (disposed) return;

    // Resizing the fluid encodes its own frames, so it waits for the next tick.
    output.onResize(({ width, height }) => {
      pendingSize = [width, height];
    });
    motion?.addEventListener('change', onMotionPreference);
    container?.addEventListener('pointerdown', onPointerDown);
    container?.addEventListener('pointermove', onPointerMove);
    container?.addEventListener('pointerleave', onPointerLeave);
    container?.addEventListener('keydown', interact);
    container?.addEventListener('wheel', interact, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    gui = createGui(container, settings, {
      flick: () => {
        interact();
        const handle = store.handle();
        const rect = handle?.element?.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        if (!rect) return;
        const center: Vec2 = [rect.left - canvasRect.left + rect.width / 2, rect.top - canvasRect.top + rect.height / 2];
        flick(
          { center, previous: center, velocity: [0, 0], speed: 0, radius: rect.width / 2, radii: [1, 1], lift: 0, contacts: [] },
          true,
        );
      },
      clear: () => {
        drainFor = DRAIN_SECONDS;
      },
      quality: () => pipeline?.setQuality(settings.quality),
      throwSettings: () => store.setSettings(pickThrow(settings)),
    });

    // keepAlive: Motion calls tick every frame, after its own style writes.
    motionFrame.postRender(tick, true);
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

function pickThrow(source: ThrowSettings): ThrowSettings {
  return {
    size: source.size,
    power: source.power,
    timeConstant: source.timeConstant,
    bounceStiffness: source.bounceStiffness,
    bounceDamping: source.bounceDamping,
    elastic: source.elastic,
  };
}

function createGui(
  container: HTMLElement | undefined,
  settings: Settings,
  actions: { flick: () => void; clear: () => void; quality: () => void; throwSettings: () => void },
): GUI {
  if (!container) throw new Error('Throwable Fluid needs a GUI container');

  let gui: GUI | undefined;
  try {
    const panel = new GUI({ title: 'Throwable Fluid', container, width: GUI_WIDTH });
    gui = panel;
    Object.assign(panel.domElement.style, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
      transition: 'opacity 200ms',
    });
    panel.onOpenClose((changed) => {
      if (changed !== panel) return;
      panel.domElement.style.setProperty('--width', `${panel._closed ? GUI_CLOSED_WIDTH : GUI_WIDTH}px`);
    });
    gui.add(actions, 'flick').name('Flick the orb');
    gui.add(actions, 'clear').name('Clear the ink');
    gui.add(settings, 'autoplay').name('Idle flicks');
    const fluid = gui.addFolder('Fluid');
    fluid.add(settings, 'viscosity', 0, 0.2, 0.005).name('Viscosity');
    fluid.add(settings, 'dissipation', 0, 2, 0.05).name('Ink fade');
    fluid.add(settings, 'vorticity', 0, 60, 1).name('Vorticity');
    fluid.add(settings, 'palette', PALETTE_NAMES).name('Palette');
    fluid.add(settings, 'quality', { Low: 'low', Medium: 'medium', High: 'high' }).name('Resolution').onChange(actions.quality);
    const orb = gui.addFolder('Orb');
    orb.add(settings, 'size', 60, 200, 1).name('Size').onChange(actions.throwSettings);
    orb.add(settings, 'refraction', 0, 2.5, 0.05).name('Refraction');
    orb.add(settings, 'dispersion', 0, 3, 0.05).name('Dispersion');
    const motionFolder = gui.addFolder('Throw (Motion)');
    motionFolder.add(settings, 'power', 0.1, 1.5, 0.05).name('Power').onChange(actions.throwSettings);
    motionFolder.add(settings, 'timeConstant', 100, 1500, 10).name('Time constant').onChange(actions.throwSettings);
    motionFolder.add(settings, 'bounceStiffness', 50, 1500, 10).name('Bounce stiffness').onChange(actions.throwSettings);
    motionFolder.add(settings, 'bounceDamping', 2, 80, 1).name('Bounce damping').onChange(actions.throwSettings);
    motionFolder.add(settings, 'elastic', 0, 1, 0.05).name('Elasticity').onChange(actions.throwSettings);
    // Open, the panel covers the top-right of the tank on smaller screens.
    if (container.clientWidth < GUI_OPEN_MIN_WIDTH) gui.close();
    return gui;
  } catch (error) {
    bestEffort(() => gui?.destroy());
    throw error;
  }
}
