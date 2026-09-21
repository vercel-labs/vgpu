import {
  PRISM_DISPERSION_PRESETS,
  type PrismControls,
  type PrismTheme,
} from "../../types";

export function formatPrismControlChanges(
  controls: PrismControls,
  baseline: PrismControls,
  mode: PrismTheme
): string | null {
  const current = activeControlValues(controls, mode);
  const changes = changedValues(current, activeControlValues(baseline, mode));
  if (!changes) return null;

  return `Apply these Prism ${mode}-mode control changes as the new defaults:\n\n\`\`\`json\n${JSON.stringify(
    { theme: mode, changes },
    null,
    2
  )}\n\`\`\``;
}

function activeControlValues(controls: PrismControls, mode: PrismTheme) {
  return {
    shared: {
      cameraFov: controls.cameraFov,
      beamWidth: controls.beamWidth,
      beamMouseY: controls.beamMouseY,
      dispersion: controls.dispersion,
      spectralDispersion:
        controls.spectralDispersion ??
        PRISM_DISPERSION_PRESETS[controls.dispersion],
      lightFade: controls.lightFade,
      wallColor: controls.wallColor,
    },
    glass: {
      transmission: controls.glass.transmission[mode],
      reflection: controls.glass.reflection[mode],
    },
    ...(mode === "light" ? { lightMode: controls.lightMode } : {}),
    ...(mode === "dark" ? { postprocess: controls.postprocess } : {}),
  };
}

function changedValues(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>
): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const initial = baseline[key];
    if (Array.isArray(value)) {
      if (!sameArray(value, initial)) changes[key] = value;
      continue;
    }
    if (isRecord(value) && isRecord(initial)) {
      const nested = changedValues(value, initial);
      if (nested) changes[key] = nested;
      continue;
    }
    if (!Object.is(value, initial)) changes[key] = value;
  }
  return Object.keys(changes).length === 0 ? null : changes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameArray(value: readonly unknown[], baseline: unknown): boolean {
  return (
    Array.isArray(baseline) &&
    value.length === baseline.length &&
    value.every((entry, index) => Object.is(entry, baseline[index]))
  );
}

export async function writeClipboardText(
  ownerDocument: Document,
  text: string
): Promise<void> {
  const clipboard = ownerDocument.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  const textarea = ownerDocument.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  ownerDocument.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = ownerDocument.execCommand("copy");
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error("Clipboard copy was rejected");
}
