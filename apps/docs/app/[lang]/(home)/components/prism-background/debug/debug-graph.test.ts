import { describe, expect, it, vi } from "vitest";

import {
  createPrismDebugPreviewRelay,
  NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
  type PrismDebugPreviewBridge,
} from "./preview-bridge";
import {
  createDarkDebugSources,
  createLightDebugSources,
  PRISM_DARK_DEBUG_SOURCES,
  PRISM_DARK_DEBUG_SOURCE_IDS,
  PRISM_DEBUG_SOURCES,
  PRISM_DEBUG_SOURCE_IDS,
} from "./sources";
import { createDebugGraphModel, estimatedNodeHeight } from "./graph/model";
import { layoutDebugGraphModel } from "./graph/elk-layout";
import { DEFAULT_PRISM_CONTROLS } from "../types";
import { LOW_LIGHT_MESH_LAYOUT } from "../pipelines/quality";

describe("prism debug graph descriptors", () => {
  it("keeps separate light and dark graphs internally resolvable", () => {
    expectGraph(PRISM_DEBUG_SOURCES, PRISM_DEBUG_SOURCE_IDS);
    expectGraph(PRISM_DARK_DEBUG_SOURCES, PRISM_DARK_DEBUG_SOURCE_IDS);
  });

  it("embeds controls into meaningful render nodes", () => {
    expect(PRISM_DEBUG_SOURCES.some(({ kind }) => kind === "control")).toBe(
      false
    );
    expect(
      PRISM_DARK_DEBUG_SOURCES.some(({ kind }) => kind === "control")
    ).toBe(false);
  });

  it("models the light render-pass draw order explicitly", () => {
    const backdrop = PRISM_DEBUG_SOURCES.find(
      ({ id }) => id === "light-backdrop-pass"
    );
    const scene = PRISM_DEBUG_SOURCES.find(
      ({ id }) => id === "light-scene-pass"
    );

    expect(backdrop?.visualization).toBe("none");
    expect(backdrop?.inputs.map(({ source }) => source)).toEqual([
      "composed-wall",
      "prism-shadow",
      "projected-caustic",
      "back-glass",
      "internal-caustic",
    ]);
    expect(scene?.visualization).toBe("none");
    expect(scene?.inputs.map(({ source }) => source)).toEqual([
      "copy-backdrop",
      "front-glass",
      "glass-accent",
    ]);
  });

  it("reports live target formats and sample counts without requiring previews", () => {
    expect(detailValue(PRISM_DEBUG_SOURCES, "backdrop-hdr", "Samples")).toBe(
      "1×"
    );
    expect(detailValue(PRISM_DEBUG_SOURCES, "scene-hdr", "Samples")).toBe(
      "4× MSAA → resolve"
    );
    expect(
      detailValue(PRISM_DARK_DEBUG_SOURCES, "dark-backdrop-hdr", "Samples")
    ).toBe("1×");
    expect(
      detailValue(PRISM_DARK_DEBUG_SOURCES, "dark-scene-hdr", "Samples")
    ).toBe("4× MSAA → resolve");

    const light = createLightDebugSources({
      backdrop: { format: "rgba16float", sampleCount: 4 },
      scene: { format: "rgba16float", sampleCount: 1 },
      outputFormat: "bgra8unorm",
    });
    expect(detailValue(light, "backdrop-hdr", "Samples")).toBe(
      "4× MSAA → resolve"
    );
    expect(detailValue(light, "scene-hdr", "Samples")).toBe("1×");
    expect(detailValue(light, "final-output", "Format")).toBe("bgra8unorm");

    const dark = createDarkDebugSources({
      backdrop: { format: "rgba16float", sampleCount: 1 },
      bloom: [
        { format: "rg11b10ufloat", sampleCount: 1 },
        { format: "rg11b10ufloat", sampleCount: 1 },
        { format: "rg11b10ufloat", sampleCount: 1 },
        { format: "rgba16float", sampleCount: 1 },
      ],
    });
    expect(detailValue(dark, "dark-backdrop-hdr", "Samples")).toBe("1×");
    expect(detailValue(dark, "dark-bloom-0", "Format")).toBe("rg11b10ufloat");
  });

  it("describes the reduced low-quality graphs without phantom resources", () => {
    const light = createLightDebugSources({
      quality: "low",
      lightMeshLayout: LOW_LIGHT_MESH_LAYOUT,
    });
    expect(detailValue(light, "scene-hdr", "Samples")).toBe(
      "4× MSAA → resolve"
    );
    expect(detailValue(light, "spectral-light-mesh", "Sampling")).toBe(
      "64 wavelengths × 12 beam slices"
    );
    expect(
      light
        .find(({ id }) => id === "composed-wall")
        ?.inputs.map(({ source }) => source)
    ).toEqual(["wall-material", "wall-lighting"]);

    const dark = createDarkDebugSources({
      quality: "low",
      lightMeshLayout: LOW_LIGHT_MESH_LAYOUT,
      bloom: [
        { format: "rgba16float", sampleCount: 1 },
        { format: "rgba16float", sampleCount: 1 },
      ],
    });
    const ids = dark.map(({ id }) => id);
    expect(ids).not.toContain("dark-bloom-2");
    expect(ids).not.toContain("dark-particle-light");
    expect(detailValue(dark, "dark-scene-hdr", "Samples")).toBe(
      "4× MSAA → resolve"
    );
    expect(detailValue(dark, "dark-present-cache-pass", "Bloom strength")).toBe(
      "0.15 · low-quality override"
    );
    expect(dark.find(({ id }) => id === "dark-dust")?.inputs).toEqual([
      {
        source: "dark-bloom-1",
        operation: "particle color + illumination",
      },
    ]);
    expectGraph(dark, ids);
  });

  it.each([
    ["light", PRISM_DEBUG_SOURCES],
    ["dark", PRISM_DARK_DEBUG_SOURCES],
  ] as const)(
    "lays %s dependencies left of their consumers",
    (mode, sources) => {
      const { edges, nodes } = createDebugGraphModel(
        sources,
        NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
        mode
      );
      const xById = new Map(nodes.map((node) => [node.id, node.position.x]));

      expect(edges).toHaveLength(
        sources.reduce((count, source) => count + source.inputs.length, 0)
      );
      for (const edge of edges) {
        expect(edge.label).toEqual(expect.any(String));
        expect(xById.get(edge.source)).toBeLessThan(
          xById.get(edge.target) ?? 0
        );
      }
    }
  );

  it.each([
    ["light", PRISM_DEBUG_SOURCES],
    ["dark", PRISM_DARK_DEBUG_SOURCES],
  ] as const)(
    "auto-layouts the %s graph without node overlap and leaves edges to React Flow",
    async (mode, sources) => {
      const model = await layoutDebugGraphModel(
        createDebugGraphModel(sources, NOOP_PRISM_DEBUG_PREVIEW_BRIDGE, mode)
      );
      const rectangles = new Map(
        model.nodes.map((node) => [
          node.id,
          {
            left: node.position.x,
            right: node.position.x + 280,
            top: node.position.y,
            bottom:
              node.position.y +
              estimatedNodeHeight(node.data.source, node.data.mode),
          },
        ])
      );
      const entries = [...rectangles.entries()];

      for (let index = 0; index < entries.length; index++) {
        for (let other = index + 1; other < entries.length; other++) {
          expect(overlaps(entries[index][1], entries[other][1])).toBe(false);
        }
      }

      expect(model.edges.every((edge) => edge.data === undefined)).toBe(true);
    }
  );

  it("keeps production controls out of preview node data", () => {
    const { nodes } = createDebugGraphModel(
      PRISM_DEBUG_SOURCES,
      NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
      "light"
    );
    for (const node of nodes) {
      expect(node.data).not.toHaveProperty("controls");
      expect(node.data).not.toHaveProperty("onControlsChange");
    }
    expect(DEFAULT_PRISM_CONTROLS.view).toBe("glass");
    expect(DEFAULT_PRISM_CONTROLS.wireframe).toBe(false);
    expect(DEFAULT_PRISM_CONTROLS.lightWireframe).toBe(false);
    expect(DEFAULT_PRISM_CONTROLS.environmentDebug).toBe(false);
  });

  it.each([
    ["light", PRISM_DEBUG_SOURCES],
    ["dark", PRISM_DARK_DEBUG_SOURCES],
  ] as const)(
    "keeps %s nodes pointer-interactive without enabling drag",
    (mode, sources) => {
      const { nodes } = createDebugGraphModel(
        sources,
        NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
        mode
      );

      for (const node of nodes) {
        expect(node.style?.pointerEvents).toBe("all");
        expect(node.draggable).toBe(false);
      }
    }
  );
});

describe("prism debug preview bridge", () => {
  it("returns an imperative cleanup without reading canvas pixels", () => {
    const detach = NOOP_PRISM_DEBUG_PREVIEW_BRIDGE.attachPreview({
      canvas: {} as HTMLCanvasElement,
      source: PRISM_DEBUG_SOURCES[0],
    });
    expect(detach).toEqual(expect.any(Function));
    expect(() => detach()).not.toThrow();
  });

  it("supports renderer-owned attach and detach callbacks", () => {
    const detach = vi.fn();
    const attachPreview = vi.fn(() => detach);
    const bridge: PrismDebugPreviewBridge = { attachPreview };
    const registration = {
      canvas: {} as HTMLCanvasElement,
      source: PRISM_DEBUG_SOURCES[0],
    };

    bridge.attachPreview(registration)();
    expect(attachPreview).toHaveBeenCalledWith(registration);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("retains registrations while the GPU provider loads", () => {
    const relay = createPrismDebugPreviewRelay();
    const detach = vi.fn();
    const attachPreview = vi.fn(() => detach);
    const registration = {
      canvas: {} as HTMLCanvasElement,
      source: PRISM_DEBUG_SOURCES[0],
    };

    const unregister = relay.bridge.attachPreview(registration);
    relay.setDelegate({ attachPreview });
    expect(attachPreview).toHaveBeenCalledWith(registration);

    unregister();
    expect(detach).toHaveBeenCalledOnce();
    relay.dispose();
  });

  it("moves each live canvas exactly once when the provider changes", () => {
    const relay = createPrismDebugPreviewRelay();
    const firstDetach = vi.fn();
    const secondDetach = vi.fn();
    const canvas = {} as HTMLCanvasElement;
    const registration = { canvas, source: PRISM_DEBUG_SOURCES[0] };
    const staleUnregister = relay.bridge.attachPreview(registration);

    relay.setDelegate({ attachPreview: () => firstDetach });
    const activeUnregister = relay.bridge.attachPreview(registration);
    staleUnregister();
    expect(firstDetach).toHaveBeenCalledOnce();

    relay.setDelegate({ attachPreview: () => secondDetach });
    activeUnregister();
    expect(secondDetach).toHaveBeenCalledOnce();
  });
});

function expectGraph(
  sources: typeof PRISM_DEBUG_SOURCES | typeof PRISM_DARK_DEBUG_SOURCES,
  expectedIds: readonly string[]
): void {
  const ids = sources.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expectedIds);
  const known = new Set(ids);
  for (const source of sources) {
    for (const input of source.inputs) {
      expect(known.has(input.source), `${source.id} <- ${input.source}`).toBe(
        true
      );
    }
  }
}

function detailValue(
  sources: readonly {
    id: string;
    details?: readonly { label: string; value: string }[];
  }[],
  sourceId: string,
  label: string
): string | undefined {
  return sources
    .find(({ id }) => id === sourceId)
    ?.details?.find((detail) => detail.label === label)?.value;
}

type Rectangle = { left: number; right: number; top: number; bottom: number };

function overlaps(first: Rectangle, second: Rectangle): boolean {
  return !(
    first.right <= second.left ||
    second.right <= first.left ||
    first.bottom <= second.top ||
    second.bottom <= first.top
  );
}
