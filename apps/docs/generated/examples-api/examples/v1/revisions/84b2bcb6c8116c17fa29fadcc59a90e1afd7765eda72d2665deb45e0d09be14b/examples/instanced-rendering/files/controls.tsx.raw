import type { InstanceCount, InstancedRenderingControls } from './types';
export interface ControlsProps { value: Readonly<InstancedRenderingControls>; onChange(value: InstancedRenderingControls): void; disabled?: boolean }
export function Controls({ value, onChange, disabled = false }: ControlsProps) {
  return <label className="absolute right-3 top-3 z-[2] text-xs text-sky-100"><span className="sr-only">Instance count (1M is an opt-in stress test)</span><select aria-label="Instance count (1M is an opt-in stress test)" className="rounded-md border border-sky-800 bg-slate-950 px-2 py-1.5 text-sky-100" value={value.count} disabled={disabled} onChange={(event) => onChange({ count: Number(event.currentTarget.value) as InstanceCount })}><option value={50}>50³ (125k)</option><option value={100}>100³ (1M — stress test)</option></select></label>;
}
