import type { Frame } from "vgpu";

import type { PrismPipeline } from "../../pipelines/types";
import { createPreviewCompileCache } from "./compile-cache";
import {
  clearUnavailablePreviews,
  hasDirectRegistration,
  renderPreviewEntry,
} from "./render-entry";
import { createPreviewRegistry } from "./registrations";
import { createTargetPreviewRenderer } from "./target-preview";
import type {
  DebuggableLightPipeline,
  DebuggableTargetPipeline,
  PrismDebugDrawSet,
  PrismDebugPreviewHost,
  PrismDebugPreviewHostOptions,
} from "./types";

const DYNAMIC_INTERVAL_SECONDS = 0.1;

export function createPrismDebugPreviewHost(
  options: PrismDebugPreviewHostOptions
): PrismDebugPreviewHost {
  const requestRender = options.invalidate ?? (() => {});
  const reportError = options.onError ?? (() => {});
  const registry = createPreviewRegistry(options.gpu, requestRender);
  const targetPreview = createTargetPreviewRenderer(
    options.gpu,
    options.runtime
  );
  let disposed = false;
  const compileCache = createPreviewCompileCache(
    () => {
      if (!disposed) requestRender();
    },
    (error) => {
      if (!disposed) reportError(error);
    }
  );
  const drawCache = new WeakMap<object, Promise<PrismDebugDrawSet>>();
  let activePipeline: PrismPipeline | undefined;
  let activeDraws: PrismDebugDrawSet | undefined;
  let observedDrawPromise: Promise<PrismDebugDrawSet> | undefined;
  let pipelineEpoch = 0;
  let runtimeRevision = 0;
  let boundRevision = -1;
  let lastDynamicTime = Number.NEGATIVE_INFINITY;
  let dynamicWake: ReturnType<typeof setTimeout> | undefined;

  function syncPipeline(pipeline: PrismPipeline | undefined): void {
    if (pipeline === activePipeline) return;
    activePipeline = pipeline;
    activeDraws = undefined;
    observedDrawPromise = undefined;
    pipelineEpoch += 1;
    runtimeRevision += 1;
    boundRevision = -1;
    lastDynamicTime = Number.NEGATIVE_INFINITY;
    clearDynamicWake();
    registry.markAllDirty();
  }

  function ensureDebugDraws(pipeline: DebuggableLightPipeline): void {
    if (activeDraws || !hasDirectRegistration(registry.values(), pipeline))
      return;
    let pending = drawCache.get(pipeline);
    if (!pending) {
      pending = pipeline.createDebugDraws();
      drawCache.set(pipeline, pending);
    }
    if (pending === observedDrawPromise) return;
    observedDrawPromise = pending;
    const epoch = pipelineEpoch;
    void pending.then(
      (draws) => {
        if (disposed || activePipeline !== pipeline || epoch !== pipelineEpoch)
          return;
        activeDraws = draws;
        boundRevision = -1;
        registry.markAllDirty();
        requestRender();
      },
      (error) => {
        drawCache.delete(pipeline);
        if (disposed || activePipeline !== pipeline || epoch !== pipelineEpoch)
          return;
        observedDrawPromise = undefined;
        reportError(error);
      }
    );
  }

  function render(current: Frame, time: number): void {
    if (disposed) return;
    const pipeline = options.getPipeline();
    syncPipeline(pipeline);
    if (!isDebuggableTargetPipeline(pipeline)) {
      clearUnavailablePreviews(current, registry.values());
      return;
    }
    if (isDebuggableLightPipeline(pipeline)) ensureDebugDraws(pipeline);
    if (activeDraws && boundRevision !== runtimeRevision) {
      activeDraws.bind?.();
      boundRevision = runtimeRevision;
    }
    const now = Number.isFinite(time) ? time : 0;
    const throttleOpen =
      now < lastDynamicTime ||
      now - lastDynamicTime >= DYNAMIC_INTERVAL_SECONDS;
    let renderedDynamic = false;
    let throttled = false;
    for (const entry of registry.values()) {
      if (!entry.dirty) continue;
      if (!entry.isStatic && entry.rendered && !throttleOpen) {
        throttled = true;
        continue;
      }
      const rendered = renderPreviewEntry(
        current,
        entry,
        pipeline,
        activeDraws,
        targetPreview,
        compileCache.ready,
        reportError
      );
      if (!rendered) continue;
      entry.dirty = false;
      entry.rendered = true;
      entry.darkCleared = false;
      renderedDynamic ||= !entry.isStatic;
    }
    if (renderedDynamic) lastDynamicTime = now;
    if (throttled) scheduleDynamicWake(now);
  }

  function scheduleDynamicWake(now: number): void {
    if (dynamicWake !== undefined) return;
    const elapsed = Math.max(0, now - lastDynamicTime);
    const delay = Math.max(0, (DYNAMIC_INTERVAL_SECONDS - elapsed) * 1_000);
    dynamicWake = setTimeout(() => {
      dynamicWake = undefined;
      if (!disposed) requestRender();
    }, delay);
  }

  function clearDynamicWake(): void {
    if (dynamicWake === undefined) return;
    clearTimeout(dynamicWake);
    dynamicWake = undefined;
  }

  return {
    bridge: registry.bridge,
    render,
    invalidate() {
      if (disposed) return;
      runtimeRevision += 1;
      registry.markDynamicDirty();
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pipelineEpoch += 1;
      clearDynamicWake();
      activeDraws = undefined;
      observedDrawPromise = undefined;
      registry.dispose();
    },
  };
}

function isDebuggableLightPipeline(
  pipeline: PrismPipeline | undefined
): pipeline is DebuggableLightPipeline {
  if (!isDebuggableTargetPipeline(pipeline) || pipeline.mode !== "light")
    return false;
  const candidate = pipeline as Partial<DebuggableLightPipeline>;
  return typeof candidate.createDebugDraws === "function";
}

function isDebuggableTargetPipeline(
  pipeline: PrismPipeline | undefined
): pipeline is DebuggableTargetPipeline {
  const candidate = pipeline as Partial<DebuggableTargetPipeline> | undefined;
  return typeof candidate?.debugTarget === "function";
}
