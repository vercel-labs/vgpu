import type { RefractionMode, TransmissionControls } from './types';

export interface ControlsProps {
  value: Readonly<TransmissionControls>;
  onChange(value: TransmissionControls): void;
  disabled?: boolean;
}

export function Controls({ value, onChange, disabled = false }: ControlsProps) {
  return (
    <fieldset className="absolute right-4 top-4 z-[2] grid gap-2 rounded-2xl border border-white/20 bg-black/60 p-2.5 text-xs font-semibold text-white shadow-lg backdrop-blur">
      <legend className="sr-only">Glass material</legend>
      <label className="flex items-center gap-2 whitespace-nowrap">
        IOR
        <input
          aria-label="Index of refraction"
          type="range"
          min={1}
          max={2.4}
          step={0.01}
          value={value.ior}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, ior: event.currentTarget.valueAsNumber })}
        />
      </label>
      <label className="flex items-center gap-2 whitespace-nowrap">
        Roughness
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value.roughness}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, roughness: event.currentTarget.valueAsNumber })}
        />
      </label>
      <label className="flex items-center gap-2 whitespace-nowrap">
        <input
          type="checkbox"
          checked={value.dispersion}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, dispersion: event.currentTarget.checked })}
        />
        Chromatic dispersion
      </label>
      <label className="flex items-center gap-2 whitespace-nowrap">
        Refraction
        <select
          className="rounded bg-black/60 px-1 py-0.5"
          value={value.refraction}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, refraction: event.currentTarget.value as RefractionMode })}
        >
          <option value="simple">Simple</option>
          <option value="double">Double</option>
        </select>
      </label>
    </fieldset>
  );
}
