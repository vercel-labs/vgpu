import GUI, { type Controller } from 'lil-gui';

import type { CameraMode } from './camera';
import { BATCH_SIZE, BOUNCE_RANGE, DEFAULT_BOUNCE, GRAVITY_RANGE } from './simulation';

/** Everything the panel edits; the renderer applies changes through ControlActions. */
export interface Settings {
  autoRelease: boolean;
  paused: boolean;
  gravity: number;
  bounce: number;
  camera: CameraMode;
}

/** Reduced motion keeps the physics live but stops the automatic releases and the follow camera. */
export function defaultSettings(reducedMotion: boolean): Settings {
  return { autoRelease: !reducedMotion, paused: false, gravity: 1, bounce: DEFAULT_BOUNCE, camera: 'machine' };
}

export interface ControlActions {
  release(): void;
  releaseBatch(): void;
  autoRelease(enabled: boolean): void;
  paused(paused: boolean): void;
  step(): void;
  gravity(scale: number): void;
  bounce(bounce: number): void;
  camera(mode: CameraMode): void;
  reset(): void;
}

export interface Controls {
  /** Re-reads every value after a keyboard shortcut or media change edited the settings. */
  refresh(): void;
  destroy(): void;
}

/**
 * Below this container width (the gallery's 16:9 frame is 832 px) the open panel would cover
 * the catch tray, so it starts closed.
 */
const NARROW_WIDTH = 900;

export function createControls(container: HTMLElement, settings: Settings, actions: ControlActions): Controls {
  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: 'Marble Machine', container, width: 230 });
    Object.assign(gui.domElement.style, { position: 'absolute', top: '16px', right: '16px', zIndex: '10' });
    const buttons = {
      release: () => actions.release(),
      releaseBatch: () => actions.releaseBatch(),
      step: () => actions.step(),
      reset: () => actions.reset(),
    };
    gui.add(buttons, 'release').name('Release marble');
    gui.add(buttons, 'releaseBatch').name(`Release ${BATCH_SIZE} marbles`);
    const toggles: Controller[] = [
      gui
        .add(settings, 'autoRelease')
        .name('Auto release')
        .onChange((value: boolean) => actions.autoRelease(value)),
      gui
        .add(settings, 'paused')
        .name('Paused')
        .onChange((value: boolean) => {
          step.enable(value);
          actions.paused(value);
        }),
    ];
    // Single steps only make sense while the clock is stopped.
    const step = gui.add(buttons, 'step').name('Step 1/60 s').enable(settings.paused);
    const sliders: Controller[] = [
      gui
        .add(settings, 'gravity', GRAVITY_RANGE[0], GRAVITY_RANGE[1], 0.05)
        .name('Gravity ×')
        .onChange((value: number) => actions.gravity(value)),
      gui
        .add(settings, 'bounce', BOUNCE_RANGE[0], BOUNCE_RANGE[1], 0.05)
        .name('Bounce')
        .onChange((value: number) => actions.bounce(value)),
      gui
        .add(settings, 'camera', { Machine: 'machine', 'Follow marble': 'follow' })
        .name('Camera')
        .onChange((value: CameraMode) => actions.camera(value)),
    ];
    gui.add(buttons, 'reset').name('Reset');
    if (container.clientWidth < NARROW_WIDTH) gui.close();
    const panel = gui;
    return {
      refresh() {
        for (const controller of [...toggles, ...sliders]) controller.updateDisplay();
        step.enable(settings.paused);
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
