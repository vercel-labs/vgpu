/**
 * Consumer-cost fixture for the minimal lifecycle experience.
 *
 * This one is intentionally usable before the clean cut: `init()` and `dispose()` are the stable
 * lifecycle boundary. The experience checker is opt-in until T202-05 installs its manifest
 * ceilings, so this file is not compiled by the regular TypeScript project or test suite.
 */
import { init } from "vgpu";

export async function initAndDispose() {
  const gpu = await init();
  gpu.dispose();
}
