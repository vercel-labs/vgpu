import { SNAPSHOT_SIZE, REPRESENTATIVE_GRADIENT_WGSL } from "./shaders.js";

export const DEFAULT_SNAPSHOT_TIME = Math.PI / 4;
export const DEFAULT_SNAPSHOT_SPEED = 2;

export async function renderRepresentativeSnapshot(init) {
  const gpu = await init({ size: SNAPSHOT_SIZE });
  try {
    const target = gpu.target({ size: SNAPSHOT_SIZE, format: "rgba8unorm", label: "vgpu-snapshot-gradient" });
    const pass = gpu.pass(REPRESENTATIVE_GRADIENT_WGSL, {
      label: "vgpu-snapshot-gradient",
      set: { speed: DEFAULT_SNAPSHOT_SPEED },
    });
    pass.set({ time: DEFAULT_SNAPSHOT_TIME });
    gpu.frame((frame) => frame.pass({ target }, (encoder) => encoder.draw(pass)));
    return { pixels: await target.read(), width: SNAPSHOT_SIZE[0], height: SNAPSHOT_SIZE[1] };
  } finally {
    gpu.dispose();
  }
}
