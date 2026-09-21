"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRenderer, type PrismRenderer } from "./renderer";
import type {
  PrismDebugSource,
  PrismPipelineMode,
  PrismQualityPreference,
  PrismQualityState,
  PrismThemePreference,
} from "./pipelines/types";
import { DEFAULT_PRISM_CONTROLS, type PrismControls } from "./types";
import type { PrismControlsUpdater } from "./debug/graph/control-context";
import { preloadLightAssets } from "./pipelines/light/assets/preload";
import { preloadPrismPipeline } from "./pipeline-controller";

const PrismDebugGraph = lazy(() =>
  import("./debug/graph").then(({ PrismDebugGraph: Component }) => ({
    default: Component,
  }))
);

const PRISM_PERFORMANCE_QUERY = "prism-perf";
const PRISM_WALL_COLOR: Record<PrismPipelineMode, string> = {
  dark: "#000000",
  light: "#d2ccc2",
};

function currentPrismMode(): PrismPipelineMode {
  return document.documentElement.classList.contains("light")
    ? "light"
    : "dark";
}

export function resolvePrismMode(
  preference: PrismThemePreference,
  siteMode: PrismPipelineMode
): PrismPipelineMode {
  return preference === "auto" ? siteMode : preference;
}

interface PrismBackgroundProps {
  readonly enabled: boolean;
}

export function PrismBackground({ enabled }: PrismBackgroundProps) {
  if (!enabled) return null;
  return <PrismCanvas />;
}

function PrismCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PrismRenderer | null>(null);
  const controlsRef = useRef<PrismControls>(DEFAULT_PRISM_CONTROLS);
  const controlsFrameRef = useRef(0);
  const themePreferenceRef = useRef<PrismThemePreference>("auto");
  const qualityPreferenceRef = useRef<PrismQualityPreference>("auto");
  const requestedModeRef = useRef<PrismPipelineMode>("dark");
  const [showDebug, setShowDebug] = useState(false);
  const [debugSources, setDebugSources] = useState<
    readonly PrismDebugSource[] | undefined
  >();
  const [debugControls, setDebugControls] = useState<PrismControls>(
    DEFAULT_PRISM_CONTROLS
  );
  const [debugBaselineControls, setDebugBaselineControls] =
    useState<PrismControls>(DEFAULT_PRISM_CONTROLS);
  const [debugMode, setDebugMode] = useState<PrismPipelineMode>("dark");
  const [debugTheme, setDebugTheme] = useState<PrismThemePreference>("auto");
  const [debugQuality, setDebugQuality] = useState<PrismQualityState>({
    preference: "auto",
    effective: "high",
    reason: "initial",
  });
  const reportError = useCallback((error: unknown) => {
    console.error("Prism background failed to render.", error);
  }, []);

  const updateControls = useCallback((updater: PrismControlsUpdater) => {
    const controls = updater(controlsRef.current);
    controlsRef.current = controls;
    setDebugControls(controls);
    if (controlsFrameRef.current) return;
    controlsFrameRef.current = requestAnimationFrame(() => {
      controlsFrameRef.current = 0;
      rendererRef.current?.setControls?.(controlsRef.current);
    });
  }, []);
  const activateMode = useCallback((mode: PrismPipelineMode) => {
    requestedModeRef.current = mode;
    if (mode === "light") preloadLightAssets();
    preloadPrismPipeline(mode);
    const wallColor = PRISM_WALL_COLOR[mode];
    setDebugBaselineControls((current) =>
      current.wallColor === wallColor
        ? current
        : { ...DEFAULT_PRISM_CONTROLS, wallColor }
    );
    if (wallColor !== controlsRef.current.wallColor) {
      const nextControls = { ...controlsRef.current, wallColor };
      controlsRef.current = nextControls;
      setDebugControls(nextControls);
      rendererRef.current?.setControls?.(nextControls);
    }
    const renderer = rendererRef.current;
    if (!renderer) {
      setDebugMode(mode);
      return;
    }
    void renderer.setMode(mode).then(
      () => {
        if (
          rendererRef.current !== renderer ||
          requestedModeRef.current !== mode
        )
          return;
        setDebugMode(mode);
        setDebugSources(renderer.debugSources());
      },
      () => {
        // The renderer reports mode preparation failures through onError.
      }
    );
  }, []);
  const selectDebugTheme = useCallback(
    (preference: PrismThemePreference) => {
      themePreferenceRef.current = preference;
      setDebugTheme(preference);
      activateMode(resolvePrismMode(preference, currentPrismMode()));
    },
    [activateMode]
  );
  const selectDebugQuality = useCallback(
    (preference: PrismQualityPreference) => {
      qualityPreferenceRef.current = preference;
      setDebugQuality((current) => ({
        ...current,
        preference,
        ...(current.effective === (preference === "low" ? "low" : "high")
          ? { reason: preference === "auto" ? "initial" : "forced" }
          : {}),
      }));
      const renderer = rendererRef.current;
      if (!renderer) {
        setDebugQuality({
          preference,
          effective: preference === "low" ? "low" : "high",
          reason: preference === "auto" ? "initial" : "forced",
        });
        return;
      }
      void renderer.setQualityPreference(preference).then(
        () => {
          if (
            rendererRef.current === renderer &&
            qualityPreferenceRef.current === preference
          ) {
            const state = renderer.getQualityState();
            if (state.preference === preference) setDebugQuality(state);
            setDebugSources(renderer.debugSources());
          }
        },
        () => {
          // The renderer reports quality preparation failures through onError.
        }
      );
    },
    []
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const debugPreviews = new URLSearchParams(window.location.search).has(
      "debug"
    );
    const performanceSampling = new URLSearchParams(window.location.search).has(
      PRISM_PERFORMANCE_QUERY
    );
    setShowDebug(debugPreviews);
    const initialMode = currentPrismMode();
    if (initialMode === "light") preloadLightAssets();
    preloadPrismPipeline(initialMode);
    requestedModeRef.current = initialMode;
    setDebugMode(initialMode);
    const hero = canvas.closest<HTMLElement>("[data-hero-theme]");
    const framingElement = hero?.querySelector<HTMLElement>(
      "[data-triangle-container]"
    );
    const initialControls = {
      ...DEFAULT_PRISM_CONTROLS,
      wallColor: PRISM_WALL_COLOR[initialMode],
    };
    controlsRef.current = initialControls;
    setDebugControls(initialControls);
    setDebugBaselineControls(initialControls);
    const renderer = createRenderer({
      canvas,
      framingElement: framingElement ?? undefined,
      initialMode,
      initialQuality: qualityPreferenceRef.current,
      initialControls,
      debugPreviews,
      performanceSampling,
      onError: reportError,
    });
    rendererRef.current = renderer;
    setDebugQuality(renderer.getQualityState());
    const unsubscribeQuality = renderer.subscribeQuality((state) => {
      if (rendererRef.current !== renderer) return;
      setDebugQuality(state);
      if (debugPreviews) setDebugSources(renderer.debugSources());
    });
    let removePerformanceApi: (() => void) | undefined;
    if (performanceSampling) {
      void import("./performance/browser-api").then(
        ({ installPrismPerformanceBrowserApi }) => {
          if (rendererRef.current !== renderer) return;
          removePerformanceApi = installPrismPerformanceBrowserApi(renderer);
        },
        reportError
      );
    }
    const syncDebugSources = () => {
      if (debugPreviews && rendererRef.current === renderer)
        setDebugSources(renderer.debugSources());
    };
    const syncTheme = () => {
      if (themePreferenceRef.current !== "auto") return;
      activateMode(currentPrismMode());
    };
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    void renderer.ready.then(syncDebugSources, () => {
      // onError reports initialization failures without replacing the hero.
    });
    return () => {
      removePerformanceApi?.();
      unsubscribeQuality();
      themeObserver.disconnect();
      if (controlsFrameRef.current)
        cancelAnimationFrame(controlsFrameRef.current);
      controlsFrameRef.current = 0;
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [activateMode, reportError]);

  return (
    <div data-prism-background className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="block h-full w-full touch-none"
      />
      {showDebug ? (
        <Suspense fallback={null}>
          <PrismDebugGraph
            baselineControls={debugBaselineControls}
            bridge={rendererRef.current?.debugBridge}
            controls={debugControls}
            mode={debugMode}
            onControlsChange={updateControls}
            onQualityChange={selectDebugQuality}
            onThemeChange={selectDebugTheme}
            quality={debugQuality}
            sources={debugSources}
            theme={debugTheme}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
