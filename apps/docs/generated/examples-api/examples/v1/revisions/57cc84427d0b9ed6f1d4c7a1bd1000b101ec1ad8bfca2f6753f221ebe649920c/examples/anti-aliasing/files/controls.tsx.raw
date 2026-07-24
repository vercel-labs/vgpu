import type { AntiAliasingControls, AaMode } from './types';
import { AA_MODE_FXAA, AA_MODE_MSAA_4X, AA_MODE_OFF, AA_MODE_SSAA_2X } from './types';
export interface ControlsProps { value: Readonly<AntiAliasingControls>; onChange(value: AntiAliasingControls): void; disabled?: boolean }
export function Controls({ value, onChange, disabled = false }: ControlsProps) {
  return <label className="absolute right-4 top-4 z-[2] text-xs font-medium text-white"><span className="sr-only">Anti-aliasing mode</span><select aria-label="Anti-aliasing mode" className="rounded-full border border-white/25 bg-black/65 py-2 pl-3 pr-7 text-white shadow-lg" value={value.mode} disabled={disabled} onChange={(event) => onChange({ mode: Number(event.currentTarget.value) as AaMode })}><option value={AA_MODE_OFF}>Off</option><option value={AA_MODE_MSAA_4X}>MSAA 4×</option><option value={AA_MODE_SSAA_2X}>SSAA 2×</option><option value={AA_MODE_FXAA}>FXAA</option></select></label>;
}
