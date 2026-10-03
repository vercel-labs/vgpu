import { expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => {
  interface Control {
    model: Record<string, unknown>;
    property: string;
    args: unknown[];
    label?: string;
    enabled: boolean;
    change?: (value: unknown) => unknown;
    updateDisplay: ReturnType<typeof vi.fn>;
    name(label: string): Control;
    onChange(change: (value: unknown) => unknown): Control;
    enable(enabled?: boolean): Control;
  }
  class FakeGui {
    options: { container: { clientWidth: number } };
    domElement = { style: {} as Record<string, string> };
    destroy = vi.fn();
    close = vi.fn();
    controls: Control[] = [];

    constructor(options: FakeGui['options']) {
      this.options = options;
      instances.push(this);
      if (failNext.value) {
        failNext.value = false;
        this.add = () => {
          throw new Error('add failed');
        };
      }
    }

    add(model: Record<string, unknown>, property: string, ...args: unknown[]): Control {
      const control: Control = {
        model,
        property,
        args,
        enabled: true,
        updateDisplay: vi.fn(),
        name(label) {
          control.label = label;
          return control;
        },
        onChange(change) {
          control.change = change;
          return control;
        },
        enable(enabled = true) {
          control.enabled = enabled;
          return control;
        },
      };
      this.controls.push(control);
      return control;
    }

    control(label: string): Control {
      const found = this.controls.find((candidate) => candidate.label === label);
      if (!found) throw new Error(`No GUI control labelled ${label}`);
      return found;
    }
  }
  const instances: FakeGui[] = [];
  const failNext = { value: false };
  return { FakeGui, instances, failNext };
});

vi.mock('lil-gui', () => ({ default: harness.FakeGui }));

import { createControls, defaultSettings, type ControlActions } from './controls';
import { BOUNCE_RANGE, DEFAULT_BOUNCE, GRAVITY_RANGE } from './simulation';

function setup(width = 1280, reducedMotion = false) {
  const settings = defaultSettings(reducedMotion);
  const actions: ControlActions = {
    release: vi.fn(),
    releaseBatch: vi.fn(),
    autoRelease: vi.fn(),
    paused: vi.fn(),
    step: vi.fn(),
    gravity: vi.fn(),
    bounce: vi.fn(),
    camera: vi.fn(),
    reset: vi.fn(),
  };
  const container = { clientWidth: width } as unknown as HTMLElement;
  const controls = createControls(container, settings, actions);
  const gui = harness.instances.at(-1)!;
  return { settings, actions, controls, gui };
}

test('reduced motion starts without automatic releases', () => {
  expect(defaultSettings(false)).toEqual({ autoRelease: true, paused: false, gravity: 1, bounce: DEFAULT_BOUNCE, camera: 'machine' });
  expect(defaultSettings(true).autoRelease).toBe(false);
});

test('the panel lists every action and setting, mounted inside the example', () => {
  const { gui } = setup();
  expect(gui.controls.map((control) => control.label)).toEqual([
    'Release marble',
    'Release 8 marbles',
    'Auto release',
    'Paused',
    'Step 1/60 s',
    'Gravity ×',
    'Bounce',
    'Camera',
    'Reset',
  ]);
  expect(gui.domElement.style).toMatchObject({ position: 'absolute', top: '16px', right: '16px' });
  expect(gui.control('Gravity ×').args).toEqual([GRAVITY_RANGE[0], GRAVITY_RANGE[1], 0.05]);
  expect(gui.control('Bounce').args).toEqual([BOUNCE_RANGE[0], BOUNCE_RANGE[1], 0.05]);
  expect(gui.control('Camera').args).toEqual([{ Machine: 'machine', 'Follow marble': 'follow' }]);
  expect(gui.close).not.toHaveBeenCalled();
});

test('the panel starts closed in the gallery frame and on phones', () => {
  expect(setup(832).gui.close).toHaveBeenCalledOnce();
  expect(setup(390).gui.close).toHaveBeenCalledOnce();
});

test('buttons and settings call their actions; step is enabled only while paused', () => {
  const { gui, actions, settings } = setup();
  const press = (label: string) => {
    const control = gui.control(label);
    (control.model[control.property] as () => void)();
  };
  press('Release marble');
  press('Release 8 marbles');
  press('Reset');
  expect(actions.release).toHaveBeenCalledOnce();
  expect(actions.releaseBatch).toHaveBeenCalledOnce();
  expect(actions.reset).toHaveBeenCalledOnce();

  const step = gui.control('Step 1/60 s');
  expect(step.enabled).toBe(false);
  gui.control('Paused').change!(true);
  expect(actions.paused).toHaveBeenCalledWith(true);
  expect(step.enabled).toBe(true);
  press('Step 1/60 s');
  expect(actions.step).toHaveBeenCalledOnce();

  gui.control('Auto release').change!(false);
  gui.control('Gravity ×').change!(1.4);
  gui.control('Bounce').change!(0.6);
  gui.control('Camera').change!('follow');
  expect(actions.autoRelease).toHaveBeenCalledWith(false);
  expect(actions.gravity).toHaveBeenCalledWith(1.4);
  expect(actions.bounce).toHaveBeenCalledWith(0.6);
  expect(actions.camera).toHaveBeenCalledWith('follow');
  // The panel binds the shared settings object, so the renderer and the GUI read the same values.
  expect(gui.control('Paused').model).toBe(settings);
});

test('refresh re-reads values changed elsewhere and destroy removes the panel', () => {
  const { gui, controls, settings } = setup();
  settings.paused = true;
  controls.refresh();
  for (const label of ['Auto release', 'Paused', 'Gravity ×', 'Bounce', 'Camera']) {
    expect(gui.control(label).updateDisplay).toHaveBeenCalledOnce();
  }
  expect(gui.control('Step 1/60 s').enabled).toBe(true);
  controls.destroy();
  expect(gui.destroy).toHaveBeenCalledOnce();
});

test('a panel that fails while building is destroyed before the error surfaces', () => {
  harness.failNext.value = true;
  expect(() => setup()).toThrow('add failed');
  expect(harness.instances.at(-1)!.destroy).toHaveBeenCalledOnce();
});
