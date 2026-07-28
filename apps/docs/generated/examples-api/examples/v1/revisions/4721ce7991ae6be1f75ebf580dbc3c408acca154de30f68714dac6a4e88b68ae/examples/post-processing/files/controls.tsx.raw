import type { PostProcessingControls } from './types';
export interface ControlsProps { value: Readonly<PostProcessingControls>; onChange(value: PostProcessingControls): void; disabled?: boolean }
export function Controls({ value, onChange, disabled = false }: ControlsProps) {
  return <fieldset className="absolute right-4 top-4 z-[2] grid gap-2 rounded-2xl border border-white/20 bg-black/60 p-2.5 text-xs font-semibold text-white shadow-lg backdrop-blur"><legend className="sr-only">Post-processing effects</legend><label className="flex items-center gap-2 whitespace-nowrap"><input type="checkbox" checked={value.bloom} disabled={disabled} onChange={(event) => onChange({ ...value, bloom: event.currentTarget.checked })} />Bloom</label><label className="flex items-center gap-2 whitespace-nowrap"><input type="checkbox" checked={value.ca} disabled={disabled} onChange={(event) => onChange({ ...value, ca: event.currentTarget.checked })} />Chromatic Aberration</label></fieldset>;
}
