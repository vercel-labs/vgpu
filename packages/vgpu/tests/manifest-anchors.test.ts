import { expect, test } from "vitest";
import { deriveEmission } from "../lib/docs/generate/generate-geistdocs.js";
import { createManifest } from "../lib/docs/generate/manifest.js";

function recordsFor(symbols: readonly string[], markdown: string) {
  const repoPath = "packages/vgpu-api/src/scene/topic.docs.md";
  const allowlist = symbols.map((symbol) => `vgpu/scene ${symbol} ${repoPath}`).join("\n");
  const manifest = createManifest(allowlist, {
    exists: () => true,
    read: () => markdown,
  });

  return new Map(manifest.records.map((record) => [record.symbol, record]));
}

test.each([
  ["orbitRig", "OrbitRig", "Camera state"],
  ["instanceGeometry", "InstanceGeometry", "Instance geometry"],
])("preserves and uses each exact case-paired heading for %s and %s", (factory, type, title) => {
  const source = `---\ntitle: ${title}\n---\n\n# ${factory}\n\nFactory docs.\n\n# ${type}\n\nType docs.\n`;
  const emitted = deriveEmission({ content: source, fallbackTitle: factory });
  const records = recordsFor([factory, type], source);

  expect(emitted.title).toBe(title);
  expect([...emitted.body.matchAll(/^#\s+(.+)$/gmu)].map((match) => match[1])).toEqual([factory, type]);
  expect(records.get(factory)).toMatchObject({ anchor: factory.toLowerCase(), summary: "Factory docs." });
  expect(records.get(type)).toMatchObject({ anchor: `${type.toLowerCase()}-1`, summary: "Type docs." });
});

test("matches github-slugger when a generated suffix is already taken", () => {
  const records = recordsFor(
    ["WIDGET", "widget-1"],
    "# Widget\n\nFirst.\n\n# WIDGET\n\nSecond.\n\n# widget-1\n\nThird.\n",
  );

  expect(records.get("WIDGET")?.anchor).toBe("widget-1");
  expect(records.get("widget-1")?.anchor).toBe("widget-1-1");
});
