import type { EarthControls } from './types';

export interface ControlsProps {
  readonly value: Readonly<EarthControls>;
  readonly onChange: (value: EarthControls) => void;
  readonly disabled?: boolean;
}

export function Controls({ value, onChange, disabled = false }: ControlsProps) {
  return (
    <fieldset className="absolute right-3 top-3 z-[2] grid gap-2 rounded-lg border border-[#24405f] bg-[#060e1ac7] px-2.5 py-2 text-xs text-[#d8efff] backdrop-blur">
      <legend className="sr-only">Earth lighting controls</legend>
      <label className="flex items-center gap-2">
        <span>Sun</span>
        <input
          className="w-28"
          type="range"
          min="0"
          max="360"
          step="0.5"
          value={value.sunDegrees}
          disabled={disabled}
          onChange={(event) => onChange({ sunDegrees: Number(event.currentTarget.value), autoRotate: false })}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.autoRotate}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, autoRotate: event.currentTarget.checked })}
        />
        Auto rotate
      </label>
    </fieldset>
  );
}
