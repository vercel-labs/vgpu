import type { TriangleLedControls, TriangleLedMode } from './types';

export interface ControlsProps {
  readonly value: Readonly<TriangleLedControls>;
  readonly onChange: (value: TriangleLedControls) => void;
  readonly disabled?: boolean;
}

export function Controls({ value, onChange, disabled = false }: ControlsProps) {
  return (
    <label className="absolute right-4 top-4 z-[2] text-xs font-medium text-white">
      <span className="sr-only">Triangle LED mode</span>
      <select
        aria-label="Triangle LED mode"
        className="rounded-full border border-white/25 bg-black/65 py-2 pl-3 pr-7 text-white shadow-lg"
        value={value.mode}
        disabled={disabled}
        onChange={(event) => onChange({ mode: Number(event.currentTarget.value) as TriangleLedMode })}
      >
        <option value={-1}>Default</option>
        <option value={0}>Edge 1</option>
        <option value={1}>Edge 2</option>
        <option value={2}>Edge 3</option>
      </select>
    </label>
  );
}
