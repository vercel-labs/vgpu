export type AgentRadianceView =
  | 'final'
  | 'emitters'
  | 'jfa'
  | 'sdf'
  | 'cascade-0'
  | 'cascade-1'
  | 'cascade-2'
  | 'cascade-3'
  | 'cascade-4'
  | 'cascade-5';

export type AgentRadianceAnimation = 'center-out' | 'edge-orbit' | 'edge-then-center';
export type AgentRadianceQuality = 'web' | 'high' | 'recording';

export interface AgentRadianceControls {
  readonly view: AgentRadianceView;
  readonly animation: AgentRadianceAnimation;
  readonly quality: AgentRadianceQuality;
  readonly paused: boolean;
}

export const DEFAULT_AGENT_RADIANCE_CONTROLS: AgentRadianceControls = {
  view: 'final',
  animation: 'center-out',
  quality: 'web',
  paused: false,
};

export const AGENT_RADIANCE_ANIMATIONS: readonly {
  readonly value: AgentRadianceAnimation;
  readonly label: string;
}[] = [
  { value: 'center-out', label: 'Center-out wave' },
  { value: 'edge-orbit', label: 'Orbiting edge' },
  { value: 'edge-then-center', label: 'Edges, then center' },
];

export const AGENT_RADIANCE_ANIMATION_MODES: Readonly<Record<AgentRadianceAnimation, number>> = {
  'center-out': 0,
  'edge-orbit': 1,
  'edge-then-center': 2,
};

export interface AgentRadianceQualitySettings {
  readonly label: string;
  readonly outputScale: number;
  readonly maxOutputEdge: number;
  readonly maxSceneEdge: number;
  readonly directionBase: number;
  readonly framesPerSecond: number;
}

export const AGENT_RADIANCE_QUALITY_SETTINGS: Readonly<
  Record<AgentRadianceQuality, AgentRadianceQualitySettings>
> = {
  web: {
    label: 'Web · 4 rays',
    outputScale: 1,
    maxOutputEdge: 1920,
    maxSceneEdge: 640,
    directionBase: 2,
    framesPerSecond: 24,
  },
  high: {
    label: 'High · 9 rays',
    outputScale: 1.25,
    maxOutputEdge: 2560,
    maxSceneEdge: 800,
    directionBase: 3,
    framesPerSecond: 24,
  },
  recording: {
    label: 'Recording · 16 rays + 1.5×',
    outputScale: 1.5,
    maxOutputEdge: 3840,
    maxSceneEdge: 900,
    directionBase: 4,
    framesPerSecond: 30,
  },
};

export const AGENT_RADIANCE_QUALITIES = (Object.entries(AGENT_RADIANCE_QUALITY_SETTINGS) as [
  AgentRadianceQuality,
  AgentRadianceQualitySettings,
][]).map(([value, settings]) => ({ value, label: settings.label }));

export const AGENT_RADIANCE_VIEWS: readonly { readonly value: AgentRadianceView; readonly label: string }[] = [
  { value: 'final', label: 'Final lighting' },
  { value: 'emitters', label: 'Emitter / occluder mask' },
  { value: 'jfa', label: 'Jump-flood seeds' },
  { value: 'sdf', label: 'Distance field' },
  { value: 'cascade-0', label: 'Cascade 0 atlas' },
  { value: 'cascade-1', label: 'Cascade 1 atlas' },
  { value: 'cascade-2', label: 'Cascade 2 atlas' },
  { value: 'cascade-3', label: 'Cascade 3 atlas' },
  { value: 'cascade-4', label: 'Cascade 4 atlas' },
  { value: 'cascade-5', label: 'Cascade 5 atlas' },
];

export type PresentMode = 0 | 1 | 2 | 3 | 4;

export interface ResolvedView {
  readonly mode: PresentMode;
  readonly stopAt: number;
  readonly needsJfa: boolean;
  readonly needsSdf: boolean;
}

export function resolveView(view: AgentRadianceView, cascadeCount: number): ResolvedView {
  if (view === 'emitters') return { mode: 1, stopAt: cascadeCount, needsJfa: false, needsSdf: false };
  if (view === 'jfa') return { mode: 4, stopAt: cascadeCount, needsJfa: true, needsSdf: false };
  if (view === 'sdf') return { mode: 2, stopAt: cascadeCount, needsJfa: true, needsSdf: true };
  if (view.startsWith('cascade-')) {
    const requested = Number.parseInt(view.slice('cascade-'.length), 10);
    return {
      mode: 3,
      stopAt: Math.min(Math.max(0, requested), cascadeCount - 1),
      needsJfa: true,
      needsSdf: true,
    };
  }
  return { mode: 0, stopAt: 0, needsJfa: true, needsSdf: true };
}
