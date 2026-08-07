import {
  AGENT_RADIANCE_ANIMATIONS,
  AGENT_RADIANCE_QUALITIES,
  AGENT_RADIANCE_VIEWS,
  type AgentRadianceAnimation,
  type AgentRadianceControls,
  type AgentRadianceQuality,
  type AgentRadianceView,
} from './types';

interface ControlsProps {
  readonly value: Readonly<AgentRadianceControls>;
  readonly cascadeCount: number;
  readonly onChange: (value: AgentRadianceControls) => void;
}

export function Controls({ value, cascadeCount, onChange }: ControlsProps) {
  const views = AGENT_RADIANCE_VIEWS.filter(({ value: view }) =>
    !view.startsWith('cascade-') || Number.parseInt(view.slice('cascade-'.length), 10) < cascadeCount);

  return (
    <fieldset className="absolute right-4 top-4 z-[2] grid gap-2 rounded-2xl border border-white/15 bg-black/65 p-2.5 text-xs font-semibold text-white shadow-lg backdrop-blur">
      <legend className="sr-only">Agent radiance cascade controls</legend>
      <label className="flex items-center justify-between gap-2 whitespace-nowrap">
        Animation
        <select
          aria-label="Dot animation"
          className="rounded bg-white/10 px-1.5 py-1"
          value={value.animation}
          onChange={(event) => onChange({
            ...value,
            animation: event.currentTarget.value as AgentRadianceAnimation,
          })}
        >
          {AGENT_RADIANCE_ANIMATIONS.map((animation) => (
            <option key={animation.value} value={animation.value}>{animation.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 whitespace-nowrap">
        Quality
        <select
          aria-label="Radiance quality"
          className="rounded bg-white/10 px-1.5 py-1"
          value={value.quality}
          onChange={(event) => onChange({
            ...value,
            quality: event.currentTarget.value as AgentRadianceQuality,
          })}
        >
          {AGENT_RADIANCE_QUALITIES.map((quality) => (
            <option key={quality.value} value={quality.value}>{quality.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 whitespace-nowrap">
        View
        <select
          aria-label="Render target to display"
          className="rounded bg-white/10 px-1.5 py-1"
          value={value.view}
          onChange={(event) => onChange({ ...value, view: event.currentTarget.value as AgentRadianceView })}
        >
          {views.map((view) => <option key={view.value} value={view.value}>{view.label}</option>)}
        </select>
      </label>
      <button
        type="button"
        className="rounded bg-white/10 px-2 py-1 font-semibold hover:bg-white/20"
        onClick={() => onChange({ ...value, paused: !value.paused })}
      >
        {value.paused ? 'Resume animation' : 'Pause animation'}
      </button>
    </fieldset>
  );
}
