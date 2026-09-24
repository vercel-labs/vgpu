// Motion owns the frame. Its frameloop runs the layout projection, springs and
// drag, writes styles in `render`, and then calls this renderer in
// `postRender`. There the renderer reads each card's final on-screen rect and
// motion values, advances the vgpu clock by Motion's delta, turns the cards
// into liquid and renders in the same browser frame. React never re-renders
// per frame: the layout store only carries discrete state.

import GUI, { type Controller } from 'lil-gui';
import { cancelFrame, frame as motionFrame, frameData } from 'motion';
import { clock, frame, init, surface, type Gpu, type Surface } from 'vgpu';

import { CARD_BY_ID } from './cards';
import { clamp, createDynamics, type CardSample, type Dynamics } from './liquid-dynamics';
import { createPipeline, DEFAULT_LOOK, type LiquidPipeline } from './liquid-pipeline';
import type { Filter, LayoutStore } from './layout-store';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Hosts the lil-gui panel and receives pointer input; defaults to the canvas parent. */
  readonly container?: HTMLElement;
  readonly store: LayoutStore;
}

interface Settings {
  autoplay: boolean;
  filter: Filter;
  smoothness: number;
  refraction: number;
  dispersion: number;
  bloom: number;
  stiffness: number;
  damping: number;
}

/** `focused` is the id of the card that holds focus, which the autoplay never replaces. */
type Step = (store: LayoutStore, focused: string | null) => number;

const MAX_DPR = 2;
const LIGHT_HEIGHT = 380;
const RESUME_AFTER = 6;
const FIRST_STEP = 2.6;
const GUI_OPEN_MIN_WIDTH = 1440;

// The idle choreography: each step acts on the store and returns the pause before the next.
const SCRIPT: readonly Step[] = [
  (store) => (store.shuffle(), 3.2),
  (store) => (store.shuffle(), 3.2),
  (store) => (store.setFilter('vgpu'), 3.4),
  (store) => (store.setFilter('all'), 3.4),
  (store, focused) => (store.expand(store.visible().filter((id) => id !== focused)[2] ?? '', 'auto'), 3),
  (store) => (store.collapse(), 2.8),
  (store) => (store.shuffle(), 3.2),
  (store) => (store.setFilter('motion'), 3.4),
  (store) => (store.setFilter('all'), 3.4),
];

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Teardown must run to completion even when one step throws.
  }
}

/** Reads every mounted card as the liquid sees it: centre, unrotated size and motion values. */
export function sampleCards(store: LayoutStore, origin: { left: number; top: number }): CardSample[] {
  const samples: CardSample[] = [];
  const { returning } = store.getState();
  for (const handle of store.handles()) {
    const rect = handle.element?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) continue;
    const rotation = (handle.rotate.get() * Math.PI) / 180;
    // The rect is the rotated card's bounding box; undo the rotation to recover its size.
    const c = Math.abs(Math.cos(rotation));
    const s = Math.abs(Math.sin(rotation));
    const det = c * c - s * s;
    let width = rect.width;
    let height = rect.height;
    if (det > 0.3) {
      width = Math.max(1, (rect.width * c - rect.height * s) / det);
      height = Math.max(1, (rect.height * c - rect.width * s) / det);
    }
    samples.push({
      id: handle.id,
      layer: handle.layer,
      cx: rect.left - origin.left + rect.width / 2,
      cy: rect.top - origin.top + rect.height / 2,
      hw: width / 2,
      hh: height / 2,
      rotation,
      offsetX: handle.x.get(),
      offsetY: handle.y.get(),
      scale: handle.scale.get(),
      hue: CARD_BY_ID.get(handle.id)?.hue ?? 0,
      present: handle.present,
      hovered: handle.hovered,
      lifted: handle.layer === 'panel' || handle.id === returning,
    });
  }
  return samples;
}

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined, store }: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let pipeline: LiquidPipeline | undefined;
  let dynamics: Dynamics | undefined;
  let gui: GUI | undefined;
  let motion: MediaQueryList | undefined;
  let autoplayToggle: Controller | undefined;
  let unsubscribe: (() => void) | undefined;
  let ticking = false;

  const settings: Settings = {
    autoplay: true,
    filter: store.getState().filter,
    smoothness: 1,
    refraction: DEFAULT_LOOK.refraction,
    dispersion: DEFAULT_LOOK.dispersion,
    bloom: DEFAULT_LOOK.bloom,
    stiffness: store.getState().stiffness,
    damping: store.getState().damping,
  };

  let time = 0;
  let reducedMotion = false;
  let origin = { left: 0, top: 0, width: 0, height: 0 };
  let pointer: { x: number; y: number } | null = null;
  let pointerIdle = Number.POSITIVE_INFINITY;
  const light = { x: 0, y: 0, placed: false };
  let dim = 0;

  // Autoplay: runs while nobody interacts, pauses for RESUME_AFTER seconds after
  // input, and holds while a press, a hovering mouse, a user-opened panel or
  // keyboard focus is inside the demo: it must not reorder the cards under
  // someone reading them.
  let step = 0;
  let nextStepIn = FIRST_STEP;
  let quietFor = RESUME_AFTER;
  let pressed = false;

  const interact = () => {
    quietFor = 0;
  };
  const onPointerDown = () => {
    pressed = true;
    interact();
  };
  const onPointerUp = () => {
    pressed = false;
    interact();
  };
  const onPointerMove = (event: PointerEvent) => {
    pointer = { x: event.clientX - origin.left, y: event.clientY - origin.top };
    pointerIdle = 0;
    interact();
  };
  const onPointerLeave = () => {
    pointer = null;
  };
  const onMotionPreference = () => {
    reducedMotion = motion?.matches ?? false;
    dynamics?.setOptions({ reducedMotion });
    // Follow the system setting; the checkbox can still turn autoplay back on.
    settings.autoplay = !reducedMotion;
    autoplayToggle?.updateDisplay();
  };

  const focusedElement = (): Element | null => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active && active !== document.body && container?.contains(active) ? active : null;
  };

  const autoplay = (dt: number) => {
    const state = store.getState();
    const userOpen = state.expanded !== null && state.openedBy !== 'auto';
    const focused = focusedElement();
    const keyboardFocus = focused?.matches(':focus-visible') ?? false;
    const hovering = Array.from(store.handles()).some((handle) => handle.hovered);
    const held = pressed || hovering || userOpen || keyboardFocus;
    if (!held) quietFor += dt;
    if (!settings.autoplay || held || quietFor < RESUME_AFTER) return;
    nextStepIn -= dt;
    if (nextStepIn > 0) return;
    const action = SCRIPT[step % SCRIPT.length]!;
    step++;
    nextStepIn = action(store, focused?.getAttribute('data-card') ?? null);
  };

  const updateLight = (dt: number) => {
    pointerIdle += dt;
    const { width, height } = origin;
    // Without a pointer the key light drifts slowly across the top of the room.
    const orbit = time * (reducedMotion ? 0.08 : 0.22);
    let tx = width * (0.5 + 0.34 * Math.cos(orbit));
    let ty = height * (0.24 + 0.12 * Math.sin(orbit * 1.7));
    if (pointer && pointerIdle < 4) {
      tx = pointer.x;
      ty = pointer.y;
    }
    if (!light.placed) {
      light.x = tx;
      light.y = ty;
      light.placed = true;
    }
    const follow = 1 - Math.exp(-dt / (pointer ? 0.09 : 0.6));
    light.x += (tx - light.x) * follow;
    light.y += (ty - light.y) * follow;
  };

  const tick = () => {
    try {
      render();
    } catch (error) {
      // A frame that throws would throw again on every tick: stop once and
      // report it outside Motion's frameloop, which keeps animating the cards.
      dispose();
      queueMicrotask(() => {
        throw error;
      });
    }
  };

  const render = () => {
    if (disposed || !gpu || !output || !pipeline || !dynamics) return;
    const dt = clamp(frameData.delta, 0, 50) / 1000;
    clock(gpu).advance(dt);
    time += dt;

    const rect = canvas.getBoundingClientRect();
    // The canvas changed size: every card moved for layout reasons, not motion.
    const resized = rect.width !== origin.width || rect.height !== origin.height;
    origin = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (origin.width < 1 || origin.height < 1) return;

    autoplay(dt);
    updateLight(dt);
    const expanded = store.getState().expanded !== null;
    dim += ((expanded ? 1 : 0) - dim) * (1 - Math.exp(-dt / 0.2));

    const liquid = dynamics.update(sampleCards(store, origin), dt, [origin.width, origin.height], resized);
    pipeline.update({
      time,
      liquid,
      light: [light.x, light.y, LIGHT_HEIGHT],
      dim,
      causticSpeed: reducedMotion ? 0.08 : 0.35,
    });
    const target = output;
    const chain = pipeline;
    frame(gpu, (currentFrame) => chain.encode(currentFrame, target));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of [
      () => {
        if (ticking) cancelFrame(tick);
      },
      () => unsubscribe?.(),
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
    settings.autoplay = !reducedMotion;
    dynamics = createDynamics({ smoothness: settings.smoothness, reducedMotion });
    pipeline = createPipeline(gpu, output.size, output.dpr);
    await pipeline.prewarm(output);
    if (disposed) return;

    const chain = pipeline;
    output.onResize(({ width, height, dpr }) => chain.resize([width, height], dpr));
    motion?.addEventListener('change', onMotionPreference);
    container?.addEventListener('pointerdown', onPointerDown);
    container?.addEventListener('pointermove', onPointerMove);
    container?.addEventListener('pointerleave', onPointerLeave);
    container?.addEventListener('keydown', interact);
    container?.addEventListener('wheel', interact, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    gui = createGui(container, settings, {
      shuffle: () => {
        interact();
        store.shuffle();
      },
      filter: () => {
        interact();
        store.setFilter(settings.filter);
      },
      liquid: () => {
        dynamics?.setOptions({ smoothness: settings.smoothness });
        pipeline?.setLook({ refraction: settings.refraction, dispersion: settings.dispersion, bloom: settings.bloom });
      },
      spring: () => store.setSpring({ stiffness: settings.stiffness, damping: settings.damping }),
    });
    const filterController = gui.controllers.find((controller) => controller.property === 'filter');
    autoplayToggle = gui.controllers.find((controller) => controller.property === 'autoplay');
    unsubscribe = store.subscribe(() => {
      const { filter } = store.getState();
      if (filter === settings.filter) return;
      settings.filter = filter;
      filterController?.updateDisplay();
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

function createGui(
  container: HTMLElement | undefined,
  settings: Settings,
  actions: { shuffle: () => void; filter: () => void; liquid: () => void; spring: () => void },
): GUI {
  if (!container) throw new Error('Liquid Layout needs a GUI container');

  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: 'Liquid Layout', container, width: 230 });
    Object.assign(gui.domElement.style, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
    });
    gui.add(actions, 'shuffle').name('Shuffle');
    gui.add(settings, 'filter', { All: 'all', vgpu: 'vgpu', Motion: 'motion' }).name('Filter').onChange(actions.filter);
    gui.add(settings, 'autoplay').name('Autoplay');
    const liquid = gui.addFolder('Liquid');
    liquid.add(settings, 'smoothness', 0, 2, 0.05).name('Merge radius').onChange(actions.liquid);
    liquid.add(settings, 'refraction', 0, 48, 1).name('Refraction').onChange(actions.liquid);
    liquid.add(settings, 'dispersion', 0, 0.5, 0.01).name('Dispersion').onChange(actions.liquid);
    liquid.add(settings, 'bloom', 0, 1.5, 0.05).name('Bloom').onChange(actions.liquid);
    const spring = gui.addFolder('Layout spring');
    spring.add(settings, 'stiffness', 80, 600, 10).name('Stiffness').onChange(actions.spring);
    spring.add(settings, 'damping', 8, 60, 1).name('Damping').onChange(actions.spring);
    spring.close();
    // Open, the panel would sit on the top-right card; autoplay shows the actions meanwhile.
    if (container.clientWidth < GUI_OPEN_MIN_WIDTH) gui.close();
    return gui;
  } catch (error) {
    bestEffort(() => gui?.destroy());
    throw error;
  }
}
