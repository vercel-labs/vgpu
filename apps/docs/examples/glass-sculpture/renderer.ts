// Concept and visual design by Kazuyuki Chinda (@ckazu).

import GUI from 'lil-gui';
import { clock, frameLoop, init, surface, type Gpu } from 'vgpu';
import { installPointerInput } from './pointer-input';
import {
  DEFAULT_CONTROLS,
  createScene,
  normalizeControls,
  type SculptureControls,
} from './scene';

export function createRenderer(
  canvas: HTMLCanvasElement,
  initialControls: Readonly<SculptureControls> = DEFAULT_CONTROLS,
) {
  let disposed = false;
  let gpu: Gpu | undefined;
  const browserCleanups: Array<() => void> = [];
  const controls = normalizeControls(initialControls);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    let firstError: unknown;
    for (const cleanup of [...browserCleanups].reverse()) {
      try {
        cleanup();
      } catch (error) {
        firstError ??= error;
      }
    }
    browserCleanups.length = 0;
    try {
      gpu?.dispose();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  };

  const ready = (async () => {
    const context = await init();
    if (disposed) {
      context.dispose();
      return;
    }
    gpu = context;
    const output = surface(context, canvas, { dpr: [1, 2] });
    const scene = createScene(context, output, controls);
    browserCleanups.push(() => scene.destroy());
    await scene.prepare(output);
    if (disposed) return;

    const input = installPointerInput(canvas);
    browserCleanups.push(() => input.dispose());
    const resizeScene = () => {
      try {
        scene.resize(output.size, controls.renderScale);
      } catch (error) {
        try {
          dispose();
        } catch {
          // Teardown must not replace the resize failure.
        }
        throw error;
      }
    };
    const gui = buildGui(canvas, controls, resizeScene);
    browserCleanups.push(() => gui.destroy());
    const unsubscribeResize = output.onResize(resizeScene);
    browserCleanups.push(unsubscribeResize);

    const time = clock(context);
    let sculptureTime = 0;
    frameLoop(context, (currentFrame) => {
      try {
        input.advance(time.deltaTime);
        if (controls.spin) sculptureTime += time.deltaTime;
        scene.render(currentFrame, output, input.camera, controls, {
          sculptureTime,
          clockTime: time.time,
          deltaTime: time.deltaTime,
          light: input.light,
        });
      } catch (error) {
        try {
          dispose();
        } catch {
          // Teardown must not replace the frame failure.
        }
        throw error;
      }
    });
  })().catch((error: unknown) => {
    if (disposed) return;
    try {
      dispose();
    } catch {
      // Teardown must not replace the initialization or render failure.
    }
    throw error;
  });

  return { ready, dispose };
}

function buildGui(
  canvas: HTMLCanvasElement,
  controls: SculptureControls,
  resize: () => void,
): GUI {
  const gui = new GUI({
    title: 'Glass sculpture',
    container: canvas.parentElement ?? undefined,
    width: 200,
  });
  try {
    Object.assign(gui.domElement.style, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
    });
    gui.add(controls, 'shape', { Knot: 'knot', Gyroid: 'gyroid', Droplets: 'droplets' }).name('Shape');
    gui.add(controls, 'glass', {
      Clear: 'clear',
      Rose: 'rose',
      Cobalt: 'cobalt',
      Emerald: 'emerald',
    }).name('Glass');
    gui.add(controls, 'light', {
      Studio: 'studio',
      Noir: 'noir',
      Gel: 'gel',
      Golden: 'golden',
    }).name('Light rig');
    gui.add(controls, 'dispersion').name('Dispersion');
    gui.add(controls, 'spin').name('Turntable');
    gui.add(controls, 'renderScale', { '50%': 0.5, '75%': 0.75, '100%': 1 })
      .name('Render scale')
      .onChange(resize);
    return gui;
  } catch (error) {
    gui.destroy();
    throw error;
  }
}
