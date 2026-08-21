import type { Effect } from 'vgpu';
import { lightPulse } from './animation';
import { gaussianBlurKernel, MAX_BLUR_TAPS } from './blur-kernel';
import { hexToRgb, type FlarePlacement, type FlareSettings } from './settings';

export type FrameEffects = Readonly<{
  logo: Effect;
  rim: Effect;
  rimBlurH: Effect;
  rimBlurV: Effect;
  composite: Effect;
}>;

export function setFrameUniforms(
  effects: FrameEffects,
  size: readonly [number, number],
  blurSize: readonly [number, number],
  settings: FlareSettings,
  placement: FlarePlacement,
  light: readonly [number, number],
  frameIndex: number,
  timeSeconds: number,
  pulseHold: number,
): void {
  const blurTexel: readonly [number, number] = [1 / blurSize[0], 1 / blurSize[1]];
  effects.logo.set({
    params: {
      logoCenter: placement.logoCenter,
      logoScale: placement.logoScale,
    },
  });
  effects.rim.set({
    params: {
      light,
      sceneTexel: [1 / size[0], 1 / size[1]],
      aspect: placement.canvasToLogo,
      spotReach: settings.spotReach,
      spotStroke: settings.spotStrokePx,
    },
  });
  const blurKernel = gaussianBlurKernel(settings.blurSigma);
  const blurTaps = Array.from({ length: MAX_BLUR_TAPS }, (_, index) => {
    const tap = blurKernel.taps[index];
    return tap ? [tap.offset, tap.weight, 0, 0] : [0, 0, 0, 0];
  });
  const blurParams = {
    texelSize: blurTexel,
    taps: blurTaps,
    centerWeight: blurKernel.centerWeight,
    tapCount: blurKernel.taps.length,
  };
  effects.rimBlurH.set({ params: { ...blurParams, direction: [blurTexel[0], 0] } });
  effects.rimBlurV.set({ params: { ...blurParams, direction: [0, blurTexel[1]] } });
  // Time-based on/off breathing; the hover hold (0..1) pins the pulse fully
  // on while the pointer steers, anywhere inside the canvas.
  const pulse = lightPulse(timeSeconds);
  const attenuation = pulse + (1 - pulse) * pulseHold;
  effects.composite.set({
    params: {
      light,
      aspect: placement.canvasToLogo,
      logoCenter: placement.logoCenter,
      flareColor: hexToRgb(settings.flareColor),
      rimIntensity: settings.intensity.rim * attenuation,
      extension: settings.extension,
      beamIntensity: settings.intensity.beam * attenuation,
      filmGrain: settings.filmGrain,
      smoothness: settings.smoothness,
      logoOpacity: settings.logoOpacity,
      frameIndex,
      spotFocus: settings.spotFocus,
      scatter: Number(settings.scatter),
      rimFill: Number(settings.rimFill),
      // The WGSL is kept byte-identical to the marketing source; this example
      // ships the dark theme only.
      lightTheme: 0,
      verticalEdgeFade: settings.verticalEdgeFade,
    },
  });
}
