'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BAKE_KEYS,
  createRenderer,
  defaultHeroSettings,
  type HeroRenderer,
  type MeasureResult,
} from './renderer';

/**
 * Set on <html> by the panel's "hide UI" toggle. The matching rule lives in
 * app/globals.css and hides every `[data-hero-overlay]` element, so the hero is
 * nothing but the shader (the lil-gui panel is outside the hero and stays).
 */
const HERO_SOLO_CLASS = 'hero-solo';

/** One-line headline for the panel's read-only field. Detail goes to the console. */
function formatMeasurement(r: MeasureResult): string {
  const gpu = r.gpuMedianMs === undefined ? '' : ` · gpu ${r.gpuMedianMs.toFixed(2)}ms`;
  const capped = r.vsyncCapped ? ' · VSYNC-CAPPED, use gpu' : '';
  return `${r.medianMs.toFixed(2)}ms (${r.fps.toFixed(0)} fps)${gpu} n=${r.samples}${capped}`;
}

export function HeroBlackHole() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(defaultHeroSettings());
  const rendererRef = useRef<HeroRenderer | null>(null);
  const [hasWebGpu, setHasWebGpu] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    async function initialize() {
      try {
        const adapter = await navigator.gpu?.requestAdapter();
        const canvas = canvasRef.current;
        if (cancelled || !adapter || !canvas) return;
        const renderer = createRenderer({
          canvas,
          settings: settingsRef.current,
          // Only the tuning panel measures anything, and the feature has to be
          // requested at device creation — so the shipped hero keeps asking for
          // exactly the device it always did. Same `?debug` test as the panel
          // effect below; duplicated rather than lifted to state because this one
          // has to be known BEFORE the device exists.
          profiling: new URLSearchParams(window.location.search).has('debug'),
          onError: (error) => {
            console.warn('[hero-black-hole] renderer failed, falling back to static image:', error);
            if (!cancelled) setHasWebGpu(false);
          },
        });
        rendererRef.current = renderer;
        dispose = renderer.dispose;
        setHasWebGpu(true);
        await renderer.ready;
      } catch {
        if (!cancelled) setHasWebGpu(false);
      }
    }

    void initialize();
    return () => { cancelled = true; rendererRef.current = null; dispose?.(); };
  }, []);

  // Dev tuning panel, gated behind `?debug` (http://localhost:3010/?debug).
  // Geometry sliders re-run the one-shot bake; the disk-look sliders are read
  // every frame and need no bake.
  useEffect(() => {
    if (!hasWebGpu) return;
    // Read the query string straight off `window` instead of useSearchParams:
    // this is a client-only concern, so it avoids dragging the component into a
    // Suspense boundary. Bailing out BEFORE the dynamic import below is what
    // keeps the lil-gui chunk from ever being requested in production.
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    let cancelled = false;
    let gui: { destroy(): void } | undefined;

    // "hide UI": drops the hero copy (header, tagline, setup snippet, the
    // legibility scrim) so the shader can be judged on its own. It is only a
    // class on <html> — see `.hero-solo` in globals.css — so it is instantly
    // reversible and never unmounts anything. Default OFF: the composed page is
    // the real design now, and this is just a tuning aid.
    const ui = { hideUi: false };
    const applyHideUi = () => document.documentElement.classList.toggle(HERO_SOLO_CLASS, ui.hideUi);
    applyHideUi();

    void import('lil-gui').then(async ({ default: GUI }) => {
      // Built only once the renderer is ready: `measure()` rejects before the
      // pipelines exist, so a panel that appeared first would offer a button
      // that fails. It therefore shows up a few hundred ms after the hero.
      await rendererRef.current?.ready.catch(() => undefined);
      if (cancelled) return;
      const settings = settingsRef.current;
      const rebake = () => rendererRef.current?.rebake();
      const panel = new GUI({ title: 'black hole' });
      panel.domElement.style.top = '72px';

      // --- perf ---------------------------------------------------------
      // Deliberately the FIRST folder: everything below it is a knob you go
      // looking for, and this is the one control whose entire value is that you
      // do not have to. Open `?debug`, click the button at the top, paste.
      const perf = panel.addFolder('perf (frame time)');
      const readout = { result: 'press "measure frame time"' };
      let busy = false;
      /** A copy waiting for the page to be clicked back into focus (see `publish`). */
      let pendingCopy: (() => void) | null = null;

      /**
       * Pasted measurements come from machines nobody here can inspect, and the
       * first two questions are always "which GPU" and "at what resolution".
       * The second is in every `MeasureResult`; this answers the first as far as
       * a page is allowed to.
       */
      const measurementContext = () => ({
        when: new Date().toISOString(),
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
      });

      /**
       * Copies text, with a hard time limit and a fallback. Returns whether the
       * clipboard actually ended up holding it.
       *
       * `navigator.clipboard.writeText` does not merely REJECT when the browser
       * is unhappy about focus: it can stay pending forever (observed here in a
       * Chromium window that never took OS focus), and an `await` on it would
       * leave the panel frozen on the previous headline with no explanation.
       * Hence the race. The `execCommand` fallback after it is deprecated but
       * synchronous, so it cannot hang, and it still works in the case the
       * async API is fussiest about — a page that has not been clicked recently,
       * which is exactly where a measurement lands after running for ~20 s.
       */
      const copyText = async (text: string): Promise<boolean> => {
        try {
          if (navigator.clipboard) {
            const written = navigator.clipboard.writeText(text).then(() => true);
            const timeout = new Promise<boolean>((resolve) => { window.setTimeout(() => resolve(false), 1500); });
            if (await Promise.race([written, timeout])) return true;
          }
        } catch {
          // Fall through: a rejection and a timeout deserve the same second try.
        }
        const scratch = document.createElement('textarea');
        scratch.value = text;
        // Off-screen but focusable and selectable — `execCommand('copy')` copies
        // the selection, so the node has to be in the document and not hidden.
        Object.assign(scratch.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0' });
        document.body.appendChild(scratch);
        scratch.select();
        try {
          return document.execCommand('copy');
        } catch {
          return false;
        } finally {
          scratch.remove();
        }
      };

      /**
       * Where a finished measurement goes: the console AND the clipboard.
       *
       * The console gets `JSON.stringify(payload, null, 2)` rather than the
       * object, because Chrome copies a logged object as the literal text
       * `{...}` — the single thing anyone wants to do with a measurement, paste
       * it somewhere, silently produced nothing. Stringifying also freezes the
       * values at log time instead of leaving DevTools to expand them later.
       *
       * The clipboard write is best effort and SAYS SO when it fails instead of
       * claiming a copy that did not happen: `writeText` rejects on a document
       * that lost focus, and a run takes ~20 s — plenty of time to click away.
       * The console line is the fallback.
       */
      const publish = async (headline: string, payload: unknown): Promise<void> => {
        const json = JSON.stringify(payload, null, 2);
        console.log(`[hero] ${headline}\n${json}`);
        if (await copyText(json)) {
          readout.result = `${headline} (copied)`;
          return;
        }
        // The clipboard refuses to write for a page that is not the focused one,
        // and a run takes ~20 s — clicking away during it is normal, so this is
        // a routine outcome rather than an error. Instead of sending the
        // reader to DevTools, arm a one-shot retry on the next click anywhere:
        // that click restores focus, and the copy the reader asked for happens
        // one gesture later instead of not at all.
        readout.result = `${headline} (click the page to copy)`;
        console.warn('[hero] clipboard blocked because the page was not focused — click the page to copy it, or take the JSON above');
        if (pendingCopy) window.removeEventListener('pointerdown', pendingCopy);
        pendingCopy = () => {
          pendingCopy = null;
          void copyText(json).then((ok) => {
            readout.result = `${headline} ${ok ? '(copied)' : '(NOT copied — JSON is in the console)'}`;
          });
        };
        window.addEventListener('pointerdown', pendingCopy, { once: true });
      };

      /**
       * Times the real loop and publishes the result.
       *
       * `busy` rather than disabling the button: lil-gui buttons have no
       * disabled state that survives `.listen()` repaints, and a second click
       * would otherwise start a measurement inside the first one's warmup.
       */
      const perfActions = {
        measure: () => {
          void (async () => {
            const renderer = rendererRef.current;
            if (!renderer || busy) return;
            busy = true;
            readout.result = 'measuring…';
            try {
              const result = await renderer.measure();
              if (result.vsyncCapped) {
                console.warn(
                  '[hero] wall-clock is vsync-capped — the frame is waiting for the display, so ms/frame ' +
                  'cannot see a change in the shader. Compare the GPU number instead.',
                );
              }
              await publish(formatMeasurement(result), { ...measurementContext(), result });
            } catch (error) {
              readout.result = 'failed — see console';
              console.error('[hero] measure failed', error);
            } finally {
              busy = false;
            }
          })();
        },
      };

      // Styled as the primary action rather than as one more row: it is the only
      // thing in this folder that does anything, and the flow it exists for is
      // open `?debug`, click once, paste.
      const primary = perf.add(perfActions, 'measure').name('▶ measure frame time');
      const primaryButton = primary.domElement.querySelector('button');
      if (primaryButton) {
        Object.assign(primaryButton.style, {
          background: '#1f6feb',
          color: '#fff',
          fontWeight: '600',
          height: '30px',
        });
      }
      // Disabled = read-only text field. `.listen()` polls the object, so the
      // async handlers above can just assign to `readout.result`.
      perf.add(readout, 'result').name('last measurement').disable().listen();
      // Geometry invalidates the baked G-buffer. No onChange wiring needed: the
      // renderer polls BAKE_KEYS every frame and re-bakes on a throttle with a
      // trailing edge, so dragging a slider stays smooth and the released value
      // always gets baked. That also makes it impossible to forget a key here.
      const geometry = panel.addFolder(`geometry (auto re-bakes: ${BAKE_KEYS.join(', ')})`);
      // Slider ranges are sized to leave headroom on BOTH sides of the shipped
      // default, so every knob stays tunable from the panel without editing code.
      geometry.add(settings, 'cameraY', -0.4, 0.6, 0.005).name('camera Y (rad)');
      geometry.add(settings, 'distance', 6, 40, 0.5).name('size (camera dist)');
      geometry.add(settings, 'diskRadius', 3.5, 30, 0.1).name('disk radius');
      geometry.add(settings, 'fov', 0.6, 5, 0.01).name('fov (focal len)');
      geometry.add(settings, 'centerY', -1, 1, 0.01).name('center Y (ndc, + = up)');

      // Mouse rotation is a per-frame uniform, NOT geometry: the scene is
      // axisymmetric, so turning it around Y reuses the same baked G-buffer.
      // 0 disables the interaction entirely.
      const interaction = panel.addFolder('interaction (per frame)');
      interaction.add(settings, 'mouseYaw', 0, 0.4, 0.005).name('mouse yaw max (rad)');

      // --- disk.wgsl owns this block (DiskLook) ---
      const disk = panel.addFolder('disk look (per frame)');
      // brightness lives near 0.05 now that disk.wgsl carries a much larger
      // internal gain, so this slider is deliberately fine-grained.
      disk.add(settings.disk, 'brightness', 0, 0.6, 0.002).name('brightness');
      disk.add(settings.disk, 'speed', 0, 2, 0.005).name('rotation speed');
      disk.add(settings.disk, 'stretch', 0.2, 12, 0.05).name('tangential stretch');
      disk.add(settings.disk, 'detail', 0.1, 8, 0.01).name('radial detail');
      disk.add(settings.disk, 'turbulence', 0, 8, 0.01).name('turbulence');
      disk.add(settings.disk, 'density', 0, 3, 0.01).name('smoke density');
      disk.add(settings.disk, 'doppler', 0, 2, 0.01).name('doppler');
      const diskSpares = disk.addFolder('spare knobs').close();
      diskSpares.add(settings.disk, 'spare0', -2, 2, 0.01).name('disk spare 0');
      diskSpares.add(settings.disk, 'spare1', -2, 2, 0.01).name('disk spare 1');
      diskSpares.add(settings.disk, 'spare2', -2, 2, 0.01).name('disk spare 2');
      diskSpares.add(settings.disk, 'spare3', -2, 2, 0.01).name('disk spare 3');

      // --- stars.wgsl owns this block (StarLook) ---
      const stars = panel.addFolder('star field (per frame)').close();
      // Pure exposure: stars.wgsl owns the absolute scale, and 1.0 is the
      // calibrated look (brightest anchors at the top of the ACES curve).
      stars.add(settings.stars, 'brightness', 0, 3, 0.01).name('exposure');
      // A real population multiplier: it scales each species' per-cell
      // probability, so the whole 0..2.5 range moves the star count (the old
      // slider was clamped to 1 inside the shader and dead above it). The three
      // species saturate at different points past ~2.2.
      stars.add(settings.stars, 'density', 0, 2.5, 0.01).name('density');
      // Dynamic range of the power law the magnitudes are drawn from. 1 = every
      // star identical (the old look); 30 = the shipped sky; higher = starker,
      // with rarer bright stars over a fainter wash.
      stars.add(settings.stars, 'contrast', 1, 80, 0.5).name('magnitude range');
      // Chroma-only per-star colour temperature (warm K/M <-> blue-white B/A).
      // Currently a no-op in the final image: `tonemap` in shade.wgsl runs
      // SATURATION = 0, which desaturates the hero completely.
      stars.add(settings.stars, 'warmth', 0, 1, 0.01).name('colour temperature');
      stars.add(settings.stars, 'twinkle', 0, 1, 0.01).name('twinkle');

      const debug = panel.addFolder('debug');
      debug.add(ui, 'hideUi').name('hide UI (hero copy)').onChange(applyHideUi);
      debug.add(settings, 'debugView', {
        off: 0,
        'normals / side': 1,
        'disk coords': 2,
        'flags (hit/hole/sky)': 3,
        'lensed ray dir': 4,
        'disk density': 5,
        'sky footprint / prefilter': 6,
        'second disk hit': 7,
        'ring aa (cov/span/taps)': 8,
        'ring aa (synth crossings)': 9,
      }).name('g-buffer view');
      // A/B for the photon-ring antialiasing. `off` is exactly the pre-AA image:
      // the one-shot refine pass still runs, the frame pass just ignores its
      // coverage/span target, so this is a pure shading switch with no re-bake.
      debug.add(settings, 'aa', {
        'off (point sampled)': 0,
        'on (coverage + radial prefilter)': 1,
      }).name('photon-ring aa');
      // A/B for the second baked disk crossing: 1 shows what the renderer looked
      // like when a ray stopped at its first hit, 2 is the intended result.
      debug.add(settings, 'diskLayers', {
        'front hit only': 1,
        'front + hidden hit': 2,
      }).name('disk layers');

      const actions = {
        'copy JSON': () => {
          void navigator.clipboard?.writeText(JSON.stringify(settings, null, 2));
        },
        're-bake': rebake,
      };
      panel.add(actions, 'copy JSON');
      panel.add(actions, 're-bake');
      gui = panel;
    });

    return () => {
      cancelled = true;
      gui?.destroy();
      document.documentElement.classList.remove(HERO_SOLO_CLASS);
    };
  }, [hasWebGpu]);

  // Full-bleed: the canvas covers the entire hero section, with no gradient mask.
  //
  // There is deliberately no still-image fallback. A pre-rendered PNG under the
  // canvas flashed on every load and never matched the shader's current look,
  // so it read as a glitch rather than as progressive enhancement. The wrapper
  // is bg-black and the canvas fades up over it: before the shader is ready, and
  // on machines with no WebGPU at all, the hero is simply black with the copy on
  // top. That is the intended presentation, not a degraded one.
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-black">
      <canvas ref={canvasRef} className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-500 ${hasWebGpu ? 'opacity-100' : 'opacity-0'}`} />
    </div>
  );
}
