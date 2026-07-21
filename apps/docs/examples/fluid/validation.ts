import type { Gpu, Target } from 'vgpu';
import type { StirInput } from './controls';
import { createFluid, prepareFluid, renderFluid, stepFluid, type Fluid } from './simulation';

export interface FluidValidationStats {
  steps: number;
  finite: boolean;
  maxSpeed: number;
  maxDye: number;
  averageDye: number;
}

export async function renderThumb(
  gpu: Gpu,
  target: Target,
  options: {
    warmupFrames?: number;
    scriptedDrag?: boolean;
    soak?: boolean;
    onStateValidated?: (stats: FluidValidationStats) => void;
  } = {},
): Promise<void> {
  const fluid = createFluid(gpu);
  await prepareFluid(fluid, target);

  if (options.soak) {
    const pointer = scriptedInput(0.37, 0.42, 0.4, Infinity);
    for (let i = 0; i < 6_000; i++) {
      stepFluid(fluid, i < 5_000 ? undefined : pointer);
      if ((i + 1) % 500 === 0) {
        await gpu.gpu.queue.onSubmittedWorkDone();
        options.onStateValidated?.(await readStats(fluid));
      }
    }
  } else {
    const pointer = options.scriptedDrag ? scriptedInput(0.08, 0.28, 0.24, 40) : undefined;
    for (let i = 0; i < (options.warmupFrames ?? 120); i++) stepFluid(fluid, pointer);
  }

  renderFluid(fluid, target);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  options.onStateValidated?.(await readStats(fluid));
}

function scriptedInput(rate: number, radiusX: number, radiusY: number, activeSteps: number): StirInput {
  let step = 0;
  const point = (n: number): [number, number] => [
    0.5 + radiusX * Math.sin(n * rate),
    0.5 + radiusY * Math.sin(n * rate * 1.61 + 1.2),
  ];
  return {
    get active() { return step < activeSteps; },
    get from() { return point(step - 1); },
    get to() { return point(step); },
    get velocity() {
      const from = point(step - 1), to = point(step);
      return [(to[0] - from[0]) * 60, (to[1] - from[1]) * 60] as [number, number];
    },
    stroke: 1,
    consumeStep() { step++; },
    dispose() {},
  };
}

async function readStats(fluid: Fluid): Promise<FluidValidationStats> {
  const [velocityBytes, dyeBytes] = await Promise.all([fluid.velocity.read.read(), fluid.dye.read.read()]);
  const velocity = new Float32Array(velocityBytes);
  const dye = new Float32Array(dyeBytes);
  let finite = true, maxSpeed = 0, maxDye = 0, dyeSum = 0;
  for (let i = 0; i < velocity.length; i += 2) {
    finite &&= Number.isFinite(velocity[i]) && Number.isFinite(velocity[i + 1]);
    maxSpeed = Math.max(maxSpeed, Math.hypot(velocity[i]!, velocity[i + 1]!));
  }
  for (const value of dye) {
    finite &&= Number.isFinite(value);
    maxDye = Math.max(maxDye, value);
    dyeSum += value;
  }
  return { steps: fluid.step, finite, maxSpeed, maxDye, averageDye: dyeSum / dye.length };
}
