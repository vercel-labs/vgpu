import GUI from "lil-gui";
import type { Buffer, Gpu, Surface } from "vgpu";
import { surface } from "vgpu";
import {
  assertGpuTensor,
  createSharedDeviceSession,
  FirstError,
  OrtEnvironmentError,
  OrtInitCancelled,
  withWrappedTensor,
  type OrtTensor,
  type SharedDeviceSession,
} from "./ort-webgpu";
import { foregroundFromRgba, preprocessDigit } from "./preprocess";
import { createChart, createLogitsBuffer } from "./renderer";

type Phase = "initializing" | "ready" | "classifying" | "unsupported" | "error";
type Point = { x: number; y: number };

const STAGE_LABELS: Record<string, string> = {
  runtime: "Loading ONNX Runtime Web…",
  model: "Fetching the 26 kB model…",
  session: "Creating the WebGPU session…",
  device: "Adopting the runtime device…",
};
const DRAW_DEBOUNCE_MS = 120;
const FIXTURE_SURFACE = 280;
const STROKE_RADIUS = 11;
const MODEL_URL = "/models/mnist/mnist-12.onnx";
const MODEL_INPUT_NAME = "Input3";
const MODEL_OUTPUT_NAME = "Plus214_Output_0";
const INPUT_SHAPE = [1, 1, 28, 28] as const;
const FIXTURE_STROKE = [
  [74, 68],
  [208, 62],
  [168, 132],
  [120, 232],
] as const;

export function createRenderer(root: HTMLElement) {
  const ui = getUi(root);
  const drawingContext = ui.draw.getContext("2d", {
    willReadFrequently: true,
  });
  if (!drawingContext) throw new Error("MNIST drawing canvas is unavailable.");
  const context: CanvasRenderingContext2D = drawingContext;

  let disposed = false;
  let shared: SharedDeviceSession | undefined;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let chart: ReturnType<typeof createChart> | undefined;
  let idleLogits: Buffer | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let drain: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let pending: Float32Array | undefined;
  let currentInput: Float32Array | undefined;
  let requested = 0;
  let runs = 0;
  const abort = new AbortController();

  function updateStatus(phase: Phase, detail?: string): void {
    ui.loading.hidden = phase !== "initializing";
    ui.loadingDetail.textContent =
      (detail && STAGE_LABELS[detail]) ?? "Preparing inference…";
    const failed = phase === "unsupported" || phase === "error";
    ui.failure.hidden = !failed;
    ui.failureTitle.textContent =
      phase === "unsupported"
        ? "WebGPU inference is required"
        : "Inference failed";
    ui.failureDetail.textContent = failed ? detail ?? "" : "";
    ui.failureDetail.hidden = !failed || !detail;
    ui.dot.className = `inline-block h-1.5 w-1.5 rounded-full ${
      phase === "classifying"
        ? "bg-blue-9"
        : phase === "ready"
        ? "bg-gray-8"
        : "bg-gray-6"
    }`;
    ui.status.textContent =
      phase === "classifying" ? "running inference…" : `inferences: ${runs}`;
  }

  function drawIdle(): void {
    if (!disposed && gpu && output && chart && idleLogits)
      chart(gpu, output, idleLogits, false);
  }

  function classify(pixels: Float32Array): void {
    if (disposed) return;
    currentInput = pixels;
    pending = pixels;
    requested += 1;
    startDrain();
  }

  function startDrain(): void {
    if (drain || disposed) return;
    const task = runDrainLoop();
    drain = task;
    void task.catch(fail).then(() => {
      if (drain === task) drain = undefined;
      if (pending) startDrain();
    });
  }

  async function runDrainLoop(): Promise<void> {
    while (!disposed && pending) {
      const pixels = pending;
      pending = undefined;
      await runOnce(pixels, requested);
    }
  }

  async function runOnce(pixels: Float32Array, generation: number) {
    const active = shared;
    const activeGpu = gpu;
    const activeOutput = output;
    const activeChart = chart;
    if (disposed || !active || !activeGpu || !activeOutput || !activeChart)
      return;

    updateStatus("classifying");
    const inputName = active.session.inputNames[0] ?? MODEL_INPUT_NAME;
    const outputName = active.session.outputNames[0] ?? MODEL_OUTPUT_NAME;
    let input: OrtTensor | undefined;
    let tensors: Record<string, OrtTensor> | undefined;
    const errors = new FirstError();
    try {
      input = new active.ort.Tensor("float32", pixels, INPUT_SHAPE);
      tensors = await active.session.run({ [inputName]: input });
      const logits = assertGpuTensor(tensors[outputName]);
      if (!disposed && generation === requested && shared === active) {
        await withWrappedTensor(activeGpu, logits, (wrapped) => {
          activeChart(activeGpu, activeOutput, wrapped, true);
        });
        runs += 1;
        updateStatus("ready");
      }
    } catch (error) {
      errors.capture(error);
    }

    for (const tensor of new Set([
      ...Object.values(tensors ?? {}),
      ...(input ? [input] : []),
    ])) {
      errors.run(() => tensor.dispose());
    }
    errors.throwIfAny();
  }

  function clearResult(): void {
    if (disposed) return;
    pending = undefined;
    requested += 1;
    currentInput = undefined;
    drawIdle();
    updateStatus("ready");
  }

  function submit(): void {
    const size = FIXTURE_SURFACE;
    const { data } = context.getImageData(0, 0, size, size);
    const field = foregroundFromRgba(data, size, size);
    const pixels = preprocessDigit(field, size, size);
    if (pixels) classify(pixels);
    else clearResult();
  }

  const drawing = installDrawing(ui.draw, context, submit);
  paintBackground(context);
  context.beginPath();
  FIXTURE_STROKE.forEach(([x, y], index) =>
    index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)
  );
  context.stroke();

  const controls = {
    clear() {
      drawing.cancel();
      paintBackground(context);
      clearResult();
    },
  };
  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: "MNIST Classifier", container: root, width: 180 });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    gui.add(controls, "clear").name("Clear");
  } catch (error) {
    try {
      drawing.dispose();
    } catch {}
    try {
      gui?.destroy();
    } catch {}
    throw error;
  }

  function measure(): void {
    if (disposed || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (!output) return;
      const { width, height } = ui.chart.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      try {
        output.resize([
          Math.max(1, Math.round(width * dpr)),
          Math.max(1, Math.round(height * dpr)),
        ]);
        if (currentInput) classify(currentInput);
        else drawIdle();
      } catch (error) {
        fail(error);
      }
    });
  }

  const onWindowResize = () => measure();

  async function initialize(): Promise<void> {
    updateStatus("initializing");
    const next = await createSharedDeviceSession({
      modelUrl: MODEL_URL,
      label: "mnist-classifier",
      signal: abort.signal,
      isCancelled: () => disposed,
      onStage: (stage) => updateStatus("initializing", stage),
    });
    if (disposed) {
      await next.release().catch(() => undefined);
      return;
    }

    shared = next;
    gpu = next.gpu;
    output = surface(gpu, ui.chart, { dpr: [1, 2] });
    chart = createChart(gpu);
    idleLogits = createLogitsBuffer(gpu);
    if (typeof ResizeObserver !== "undefined")
      observer = new ResizeObserver(measure);
    observer?.observe(ui.chart);
    window.addEventListener("resize", onWindowResize);
    measure();
    drawIdle();
    updateStatus("ready");
    submit();
  }

  function fail(error: unknown): void {
    if (disposed || error instanceof OrtInitCancelled) return;
    showFailure(error);
    void shutdown(error, true).catch((failure) => {
      queueMicrotask(() => {
        throw failure;
      });
    });
  }

  function showFailure(error: unknown): void {
    try {
      updateStatus(
        error instanceof OrtEnvironmentError ? "unsupported" : "error",
        error instanceof Error ? error.message : String(error)
      );
    } catch {}
  }

  function shutdown(primary?: unknown, hasPrimary = false): Promise<void> {
    if (closing) return closing;
    disposed = true;
    pending = undefined;
    requested += 1;
    const activeDrain = drain;
    const errors = new FirstError(primary, hasPrimary);
    const clean = (cleanup: () => void) => {
      try {
        cleanup();
      } catch (error) {
        if (hasPrimary) errors.capture(error);
      }
    };

    clean(() => abort.abort());
    clean(drawing.dispose);
    if (resizeFrame) clean(() => cancelAnimationFrame(resizeFrame));
    clean(() => observer?.disconnect());
    clean(() => window.removeEventListener("resize", onWindowResize));
    clean(() => gui?.destroy());

    closing = (async () => {
      if (hasPrimary) await errors.wait(activeDrain);
      else await Promise.allSettled([activeDrain]);
      if (hasPrimary) await errors.wait(shared?.release());
      else await shared?.release().catch(() => undefined);
      errors.throwIfAny();
    })();
    return closing;
  }

  const ready = initialize().catch((error: unknown) => {
    if (disposed || error instanceof OrtInitCancelled) return;
    showFailure(error);
    return shutdown(error, true);
  });

  return {
    ready,
    dispose() {
      void shutdown();
    },
  };
}

function paintBackground(context: CanvasRenderingContext2D): void {
  context.fillStyle = "#000000";
  context.fillRect(0, 0, FIXTURE_SURFACE, FIXTURE_SURFACE);
  context.strokeStyle = "#ffffff";
  context.lineWidth = STROKE_RADIUS * 2;
  context.lineCap = "round";
  context.lineJoin = "round";
}

export function installDrawing(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  submit: () => void
) {
  let drawing = false;
  let last: Point | undefined;
  let pointerId: number | undefined;
  let debounce = 0;

  const position = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * FIXTURE_SURFACE,
      y: ((event.clientY - rect.top) / rect.height) * FIXTURE_SURFACE,
    };
  };
  const stroke = (from: Point, to: Point) => {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  };
  const schedule = () => {
    if (debounce) return;
    debounce = window.setTimeout(() => {
      debounce = 0;
      submit();
    }, DRAW_DEBOUNCE_MS);
  };
  const down = (event: PointerEvent) => {
    canvas.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    drawing = true;
    const point = position(event);
    last = point;
    stroke(point, { x: point.x + 0.01, y: point.y });
    schedule();
  };
  const move = (event: PointerEvent) => {
    if (!drawing || !last) return;
    const point = position(event);
    stroke(last, point);
    last = point;
    schedule();
  };
  const cancel = () => {
    drawing = false;
    last = undefined;
    if (debounce) window.clearTimeout(debounce);
    debounce = 0;
    if (pointerId !== undefined) {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {}
      pointerId = undefined;
    }
  };
  const end = () => {
    if (!drawing) return;
    cancel();
    submit();
  };

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  const endEvents = ["pointerup", "pointercancel", "pointerleave"] as const;
  endEvents.forEach((event) => canvas.addEventListener(event, end));

  return {
    cancel,
    dispose() {
      cancel();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      endEvents.forEach((event) => canvas.removeEventListener(event, end));
    },
  };
}

function getUi(root: HTMLElement) {
  const find = <T extends Element>(name: string): T => {
    const element = root.querySelector<T>(`[data-mnist="${name}"]`);
    if (!element) throw new Error(`Missing MNIST ${name} element.`);
    return element;
  };
  return {
    draw: find<HTMLCanvasElement>("draw"),
    chart: find<HTMLCanvasElement>("chart"),
    loading: find<HTMLElement>("loading"),
    loadingDetail: find<HTMLElement>("loading-detail"),
    failure: find<HTMLElement>("failure"),
    failureTitle: find<HTMLElement>("failure-title"),
    failureDetail: find<HTMLElement>("failure-detail"),
    dot: find<HTMLElement>("dot"),
    status: find<HTMLElement>("status"),
  };
}
