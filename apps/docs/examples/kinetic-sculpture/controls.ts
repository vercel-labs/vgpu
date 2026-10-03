import GUI, { type Controller } from 'lil-gui';

import { DEFAULT_LEVELS, MAX_LEVELS, MIN_LEVELS } from './scene';

/** Everything the panel edits. The renderer reads it every frame. */
export interface Settings {
  speed: number;
  swing: number;
  levels: number;
  /** Manual yaw of the root group, in degrees. Every arm and pendant follows it. */
  rootAngle: number;
  playing: boolean;
}

const LIVELY = { speed: 1, swing: 1 } as const;
/** Reduced motion starts slower and with a smaller swing; it never freezes the mobile. */
const CALM = { speed: 0.4, swing: 0.5 } as const;

export function defaultSettings(reducedMotion: boolean): Settings {
  return { ...(reducedMotion ? CALM : LIVELY), levels: DEFAULT_LEVELS, rootAngle: 0, playing: true };
}

/**
 * Moves Speed and Swing to the new motion preset when the system setting changes, but only
 * where they still hold the previous preset: values the user picked stay as they are.
 */
export function applyMotionPreference(settings: Settings, reducedMotion: boolean): void {
  const [from, to] = reducedMotion ? [LIVELY, CALM] : [CALM, LIVELY];
  if (settings.speed === from.speed) settings.speed = to.speed;
  if (settings.swing === from.swing) settings.swing = to.swing;
}

export interface ControlActions {
  levels(levels: number): void;
  reset(): void;
}

export interface Controls {
  /** Re-reads every value after a programmatic change. */
  refresh(): void;
  destroy(): void;
}

/** lil-gui panel inside the example root; it starts closed when it would cover the mobile. */
export function createControls(container: HTMLElement, settings: Settings, actions: ControlActions): Controls {
  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: 'Kinetic Sculpture', container, width: 220 });
    Object.assign(gui.domElement.style, { position: 'absolute', top: '16px', right: '16px', zIndex: '10' });
    const controllers: Controller[] = [
      gui.add(settings, 'speed', 0, 2, 0.05).name('Speed'),
      gui.add(settings, 'swing', 0, 1.5, 0.05).name('Swing'),
      gui
        .add(settings, 'levels', MIN_LEVELS, MAX_LEVELS, 1)
        .name('Levels')
        .onFinishChange((value: number) => actions.levels(value)),
      gui.add(settings, 'rootAngle', -180, 180, 1).name('Root angle'),
    ];
    const buttons = {
      toggle: () => {
        settings.playing = !settings.playing;
        play.name(settings.playing ? 'Pause' : 'Resume');
      },
      reset: () => actions.reset(),
    };
    const play = gui.add(buttons, 'toggle').name(settings.playing ? 'Pause' : 'Resume');
    gui.add(buttons, 'reset').name('Reset');
    // Closed below the gallery's 16:9 frame width, where the open panel would cover the mobile.
    if (container.clientWidth < 900) gui.close();
    const panel = gui;
    return {
      refresh() {
        for (const controller of controllers) controller.updateDisplay();
        play.name(settings.playing ? 'Pause' : 'Resume');
      },
      destroy() {
        panel.destroy();
      },
    };
  } catch (error) {
    try {
      gui?.destroy();
    } catch {}
    throw error;
  }
}
