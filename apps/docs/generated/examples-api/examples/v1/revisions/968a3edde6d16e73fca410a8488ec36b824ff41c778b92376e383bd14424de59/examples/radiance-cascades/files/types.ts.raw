/** Which render target the canvas shows. Every option is a real target, not a re-derivation. */
export type RadianceView =
  | 'final'
  | 'emitters'
  | 'sdf'
  | 'cascade-0'
  | 'cascade-1'
  | 'cascade-2'
  | 'cascade-3'
  | 'cascade-4'
  | 'cascade-5';

export interface RadianceCascadesControls {
  readonly view: RadianceView;
}

export const DEFAULT_RADIANCE_CASCADES_CONTROLS: RadianceCascadesControls = { view: 'final' };

export const RADIANCE_VIEWS: readonly { readonly value: RadianceView; readonly label: string }[] = [
  { value: 'final', label: 'Final' },
  { value: 'emitters', label: 'Emitters' },
  { value: 'sdf', label: 'Distance field' },
  { value: 'cascade-0', label: 'Cascade 0 atlas' },
  { value: 'cascade-1', label: 'Cascade 1 atlas' },
  { value: 'cascade-2', label: 'Cascade 2 atlas' },
  { value: 'cascade-3', label: 'Cascade 3 atlas' },
  { value: 'cascade-4', label: 'Cascade 4 atlas' },
  { value: 'cascade-5', label: 'Cascade 5 atlas' },
];

/** Present mode of `present.wgsl`. */
export type PresentMode = 0 | 1 | 2 | 3;

export interface ResolvedView {
  readonly mode: PresentMode;
  /**
   * Lowest cascade the chain has to compute.
   *
   * A cascade view stops the top-down descent at that level and shows the atlas it just
   * wrote, so the debug views cost less than the final image instead of needing a third
   * atlas to snapshot into.
   */
  readonly stopAt: number;
}

export function resolveView(view: RadianceView, cascadeCount: number): ResolvedView {
  if (view === 'emitters') return { mode: 1, stopAt: 0 };
  if (view === 'sdf') return { mode: 2, stopAt: 0 };
  if (view.startsWith('cascade-')) {
    const requested = Number.parseInt(view.slice('cascade-'.length), 10);
    // A hierarchy that only needs five levels has no cascade 5 to show.
    return { mode: 3, stopAt: Math.min(Math.max(0, requested), cascadeCount - 1) };
  }
  return { mode: 0, stopAt: 0 };
}
