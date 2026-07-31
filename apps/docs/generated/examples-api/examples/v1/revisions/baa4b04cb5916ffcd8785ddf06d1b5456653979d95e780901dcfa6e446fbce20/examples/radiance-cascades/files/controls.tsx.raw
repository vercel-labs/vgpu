import { RADIANCE_VIEWS, type RadianceCascadesControls, type RadianceView } from './types';

export interface ControlsProps {
  value: Readonly<RadianceCascadesControls>;
  onChange(value: RadianceCascadesControls): void;
  onClear(): void;
  /** Cascades the current canvas size needs; deeper views do not exist. */
  cascadeCount?: number;
  disabled?: boolean;
}

export function Controls({ value, onChange, onClear, cascadeCount = 6, disabled = false }: ControlsProps) {
  const views = RADIANCE_VIEWS.filter((view) => {
    if (!view.value.startsWith('cascade-')) return true;
    return Number.parseInt(view.value.slice('cascade-'.length), 10) < cascadeCount;
  });

  return (
    <fieldset className="absolute right-4 top-4 z-[2] grid gap-2 rounded-2xl border border-white/20 bg-black/60 p-2.5 text-xs font-semibold text-white shadow-lg backdrop-blur">
      <legend className="sr-only">Radiance cascades</legend>
      <label className="flex items-center gap-2 whitespace-nowrap">
        View
        <select
          aria-label="Render target to display"
          className="rounded bg-black/60 px-1 py-0.5"
          value={value.view}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, view: event.currentTarget.value as RadianceView })}
        >
          {views.map((view) => (
            <option key={view.value} value={view.value}>{view.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="rounded bg-white/10 px-2 py-1 font-semibold hover:bg-white/20 disabled:opacity-50"
        disabled={disabled}
        onClick={onClear}
      >
        Clear canvas
      </button>
    </fieldset>
  );
}
