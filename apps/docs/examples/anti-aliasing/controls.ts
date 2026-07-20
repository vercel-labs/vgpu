export const AA_MODE_OFF = 0;
export const AA_MODE_MSAA_4X = 1;
export const AA_MODE_SSAA_2X = 2;
export const AA_MODE_FXAA = 3;

export type AaMode =
  | typeof AA_MODE_OFF
  | typeof AA_MODE_MSAA_4X
  | typeof AA_MODE_SSAA_2X
  | typeof AA_MODE_FXAA;

export interface AntiAliasingControls {
  readonly host: HTMLElement;
  getMode(): AaMode;
  dispose(): void;
}

export function installControls(canvas: HTMLCanvasElement): AntiAliasingControls {
  const select = createModeSelect();
  const host = installSelect(canvas, select);

  return {
    host,
    getMode() {
      return Number(select.value) as AaMode;
    },
    dispose() {
      host.remove();
    },
  };
}

function createModeSelect(): HTMLSelectElement {
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Anti-aliasing mode');
  select.value = String(AA_MODE_FXAA);

  const options: Array<[AaMode, string, string]> = [
    [AA_MODE_OFF, 'off', 'Off'],
    [AA_MODE_MSAA_4X, 'msaa-4x', 'MSAA 4×'],
    [AA_MODE_SSAA_2X, 'ssaa-2x', 'SSAA 2×'],
    [AA_MODE_FXAA, 'fxaa', 'FXAA'],
  ];

  for (const [value, key, label] of options) {
    const option = document.createElement('option');
    option.value = String(value);
    option.dataset.key = key;
    option.textContent = label;
    select.append(option);
  }

  Object.assign(select.style, {
    appearance: 'auto',
    border: '1px solid rgba(255, 255, 255, 0.24)',
    borderRadius: '999px',
    background: 'rgba(0, 0, 0, 0.64)',
    color: 'white',
    font: '500 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '8px 28px 8px 12px',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.3)',
  });

  return select;
}

function installSelect(canvas: HTMLCanvasElement, select: HTMLSelectElement): HTMLElement {
  const host = document.createElement('div');
  host.append(select);
  Object.assign(host.style, {
    position: 'absolute',
    top: '16px',
    right: '16px',
    zIndex: '2',
    pointerEvents: 'auto',
  });

  const parent = canvas.parentElement;
  if (parent) {
    const position = getComputedStyle(parent).position;
    if (position === 'static') parent.style.position = 'relative';
    parent.append(host);
  } else {
    document.body.append(host);
  }

  return host;
}
