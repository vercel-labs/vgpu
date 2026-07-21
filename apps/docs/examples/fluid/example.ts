import { installStirInput } from './controls';
import { fixedStepCount } from './math';
import { createFluid, prepareFluid, renderFluid, stepFluid } from './simulation';

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const fluid = createFluid(gpu);
  const input = installStirInput(canvas);
  await prepareFluid(fluid, surface);

  let disposed = false;
  let animationFrame = 0;
  let accumulator = 0;
  let previous = performance.now();
  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) { sawInitialResize = true; return; }
    void prepareFluid(fluid, surface);
  });

  const tick = (now: number) => {
    if (disposed) return;
    if (!document.hidden) {
      const fixed = fixedStepCount(accumulator, (now - previous) / 1000);
      accumulator = fixed.accumulator;
      for (let i = 0; i < fixed.steps; i++) stepFluid(fluid, input);
      renderFluid(fluid, surface);
    }
    previous = now;
    animationFrame = requestAnimationFrame(tick);
  };
  animationFrame = requestAnimationFrame(tick);

  return () => {
    disposed = true;
    cancelAnimationFrame(animationFrame);
    unsubscribeResize();
    input.dispose();
    surface.dispose();
    gpu.dispose();
  };
}
