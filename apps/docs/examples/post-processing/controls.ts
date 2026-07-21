export interface PostProcessingFlags {
  bloom: boolean;
  ca: boolean;
}

export interface PostProcessingControls {
  readonly host: HTMLElement;
  getFlags(): PostProcessingFlags;
  onFlagsChange(listener: (flags: PostProcessingFlags) => void): () => void;
  dispose(): void;
}

const CONTROL_DEFS: Array<{ key: keyof PostProcessingFlags; label: string }> = [
  { key: 'bloom', label: 'Bloom' },
  { key: 'ca', label: 'Chromatic Aberration' },
];

export function installControls(canvas: HTMLCanvasElement): PostProcessingControls {
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'absolute',
    top: '16px',
    right: '16px',
    zIndex: '2',
    display: 'grid',
    gap: '8px',
    padding: '10px',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    borderRadius: '16px',
    background: 'linear-gradient(180deg, rgba(5, 8, 22, 0.78), rgba(5, 8, 22, 0.48))',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
    backdropFilter: 'blur(10px)',
    pointerEvents: 'auto',
  });

  const inputs = new Map<keyof PostProcessingFlags, HTMLInputElement>();
  for (const def of CONTROL_DEFS) {
    const label = document.createElement('label');
    Object.assign(label.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      color: 'white',
      font: '600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      letterSpacing: '0.01em',
      userSelect: 'none',
      textShadow: '0 1px 8px rgba(0, 0, 0, 0.35)',
      whiteSpace: 'nowrap',
    });

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.setAttribute('aria-label', def.label);
    Object.assign(input.style, {
      accentColor: '#8bd3ff',
      width: '14px',
      height: '14px',
      margin: '0',
    });

    const text = document.createElement('span');
    text.textContent = def.label;
    label.append(input, text);
    host.append(label);
    inputs.set(def.key, input);
  }

  const parent = canvas.parentElement;
  if (parent) {
    const position = getComputedStyle(parent).position;
    if (position === 'static') parent.style.position = 'relative';
    parent.append(host);
  } else {
    document.body.append(host);
  }

  const getFlags = (): PostProcessingFlags => ({
    bloom: inputs.get('bloom')?.checked ?? true,
    ca: inputs.get('ca')?.checked ?? true,
  });

  return {
    host,
    getFlags() {
      return getFlags();
    },
    onFlagsChange(listener) {
      const onChange = () => listener(getFlags());
      for (const input of inputs.values()) input.addEventListener('change', onChange);
      return () => {
        for (const input of inputs.values()) input.removeEventListener('change', onChange);
      };
    },
    dispose() {
      host.remove();
    },
  };
}
