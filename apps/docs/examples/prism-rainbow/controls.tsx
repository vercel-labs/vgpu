import {
  PRISM_DISPERSION_LABELS,
  PRISM_DISPERSION_ORDER,
  type PrismControls,
  type PrismDispersion,
} from './types';

export interface ControlsProps {
  value: Readonly<PrismControls>;
  onChange(value: PrismControls): void;
  /** Frames folded into the running average, shown so convergence is visible. */
  accumulated: number;
  disabled?: boolean;
}

export function Controls({ value, onChange, accumulated, disabled = false }: ControlsProps) {
  return (
    <fieldset className="absolute right-4 top-4 z-[2] grid gap-2 rounded-2xl border border-white/20 bg-black/60 p-2.5 text-xs font-semibold text-white shadow-lg backdrop-blur">
      <legend className="sr-only">Prism rainbow</legend>
      <label className="flex items-center gap-2 whitespace-nowrap">
        Glass
        <select
          aria-label="Dispersion preset"
          className="rounded bg-black/60 px-1 py-0.5"
          value={value.dispersion}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, dispersion: event.currentTarget.value as PrismDispersion })}
        >
          {PRISM_DISPERSION_ORDER.map((dispersion) => (
            <option key={dispersion} value={dispersion}>{PRISM_DISPERSION_LABELS[dispersion]}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 whitespace-nowrap">
        <input
          type="checkbox"
          checked={value.causticOnly}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, causticOnly: event.currentTarget.checked })}
        />
        Traced light only
      </label>
      <span className="tabular-nums font-normal text-white/70">
        {accumulated} {accumulated === 1 ? 'frame' : 'frames'} averaged
      </span>
    </fieldset>
  );
}
