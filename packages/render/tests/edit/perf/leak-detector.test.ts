import { createMockAdapter } from "@vgpu/adapter-mock";

import { Mesh } from "../../../../vgpu-api/src/scene/geometry-src/mesh.ts";
import { bevel, toEditable, type EditableMeshValue } from "@vgpu/render/edit";
import { expect, test } from "vitest";

const gc = () => (globalThis as { gc?: () => void }).gc;

test.skipIf(typeof gc() !== "function")("editable mesh values are collectable after an op; skipped without --expose-gc", async () => {
  const device = await createMockAdapter().requestDevice();
  try {
    const ref = makeDroppedEditableMesh(device);
    await forceCollection();
    expect(ref.deref()).toBeUndefined();
  } finally {
    device.destroy();
  }
});

function makeDroppedEditableMesh(device: Device): WeakRef<EditableMeshValue> {
  let em: EditableMeshValue | undefined = toEditable(Mesh.box({ device }));
  const ref = new WeakRef(em);
  em = bevel(em, em.edges.all(), { offset: 0.05 }).mesh;
  em.toRenderMesh({ device });
  em = undefined;
  return ref;
}

async function forceCollection(): Promise<void> {
  const runGc = gc();
  if (!runGc) return;
  for (let i = 0; i < 8; i++) {
    runGc();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
