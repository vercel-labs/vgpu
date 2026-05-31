"use client";

import { useEffect } from "react";

const defaults = {
  heroMinHeight: 760,
  heroContentOffset: 23,
  heroWordmarkTop: 27,
  heroWordmarkScale: 1,
  heroDotColor: "#a1a1aa",
  sectionY: 6,
  card: "#0c0c0c",
  cardHover: "#131313",
  border: "#1f1f1f",
  borderStrong: "#2e2e2e",
  surfaceAlpha: 1,
} as const;

type TuningValues = typeof defaults;

type GuiController = {
  name(label: string): GuiController;
  onChange(callback: () => void): GuiController;
};

type GuiFolder = {
  add(target: Record<string, unknown>, key: string, min?: number, max?: number, step?: number): GuiController;
  addColor(target: Record<string, unknown>, key: string): GuiController;
};

type Gui = GuiFolder & {
  addFolder(name: string): GuiFolder;
  destroy(): void;
  domElement: HTMLElement;
};

type LilGuiModule = {
  GUI: new (options?: { title?: string; width?: number }) => Gui;
};

const cssVars: Record<keyof TuningValues, string> = {
  heroMinHeight: "--hero-min-height",
  heroContentOffset: "--hero-content-offset",
  heroWordmarkTop: "--hero-wordmark-top",
  heroWordmarkScale: "--hero-wordmark-scale",
  heroDotColor: "--hero-dot-color",
  sectionY: "--section-y",
  card: "--card",
  cardHover: "--card-hover",
  border: "--border",
  borderStrong: "--border-strong",
  surfaceAlpha: "--surface-alpha",
};

function formatValue(key: keyof TuningValues, value: string | number) {
  if (key === "heroMinHeight") return `${value}px`;
  if (key === "heroContentOffset" || key === "sectionY") return `${value}rem`;
  if (key === "heroWordmarkTop") return `${value}%`;
  return String(value);
}

function diffFromDefaults(values: TuningValues) {
  const diff: Partial<Record<keyof TuningValues, string | number>> = {};
  for (const key of Object.keys(defaults) as Array<keyof TuningValues>) {
    if (values[key] !== defaults[key]) {
      diff[key] = values[key];
    }
  }
  return diff;
}

function cssPatch(values: TuningValues) {
  const diff = diffFromDefaults(values);
  const lines = Object.entries(diff).map(([key, value]) => `  ${cssVars[key as keyof TuningValues]}: ${formatValue(key as keyof TuningValues, value)};`);
  return lines.length > 0 ? `:root {\n${lines.join("\n")}\n}` : "/* No design token changes from defaults. */";
}

async function loadGui(): Promise<LilGuiModule> {
  return import("lil-gui") as Promise<LilGuiModule>;
}

export function DesignTuner({ enabled }: { readonly enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let gui: Gui | undefined;
    const root = document.documentElement;
    const values: TuningValues = { ...defaults };

    const apply = () => {
      for (const key of Object.keys(values) as Array<keyof TuningValues>) {
        root.style.setProperty(cssVars[key], formatValue(key, values[key]));
      }
    };

    const copy = async () => {
      const payload = {
        description: "VGPU site design-token diff from current defaults",
        tokens: diffFromDefaults(values),
        css: cssPatch(values),
      };
      await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
    };

    const reset = () => {
      Object.assign(values, defaults);
      apply();
      gui?.destroy();
      void setup();
    };

    async function setup() {
      const { GUI } = await loadGui();
      if (disposed) return;
      gui = new GUI({ title: "VGPU design tuner", width: 320 });
      gui.domElement.dataset.vgpuDesignTuner = "true";
      gui.domElement.style.zIndex = "60";

      const hero = gui.addFolder("Hero");
      hero.add(values, "heroMinHeight", 680, 860, 10).name("min height px").onChange(apply);
      hero.add(values, "heroContentOffset", 17, 24, 0.25).name("content offset rem").onChange(apply);
      hero.add(values, "heroWordmarkTop", 24, 34, 0.25).name("wordmark top %").onChange(apply);
      hero.add(values, "heroWordmarkScale", 0.85, 1.18, 0.01).name("wordmark scale").onChange(apply);
      hero.addColor(values, "heroDotColor").name("dot color").onChange(apply);

      const layout = gui.addFolder("Layout");
      layout.add(values, "sectionY", 4.5, 8, 0.25).name("section y rem").onChange(apply);

      const surface = gui.addFolder("Surfaces");
      surface.addColor(values, "card").name("card").onChange(apply);
      surface.addColor(values, "cardHover").name("card hover").onChange(apply);
      surface.addColor(values, "border").name("border").onChange(apply);
      surface.addColor(values, "borderStrong").name("strong border").onChange(apply);
      surface.add(values, "surfaceAlpha", 0.75, 1, 0.01).name("surface alpha").onChange(apply);

      gui.add({ copy }, "copy").name("Copy diff");
      gui.add({ reset }, "reset").name("Reset defaults");
      apply();
    }

    void setup();

    return () => {
      disposed = true;
      gui?.destroy();
      for (const key of Object.keys(cssVars) as Array<keyof TuningValues>) {
        root.style.removeProperty(cssVars[key]);
      }
    };
  }, [enabled]);

  return null;
}
