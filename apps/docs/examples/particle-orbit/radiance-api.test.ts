import { expect, test } from "vitest";
import { frame, init, target } from "vgpu/mock";
import { uniformBindingFloats } from "../../test-support/mock-uniforms";
import {
  createRadiance,
  destroyRadiance,
  setRadianceScene,
  setRadianceTime,
  type Radiance,
} from "./radiance";

test("the radiance emitter starts at time zero and retains animation when its scene is rebound", async () => {
  const gpu = await init();
  let radiance: Radiance | undefined;
  try {
    const scene = target(gpu, { size: [1000, 600], format: "rgba16float" });
    radiance = createRadiance(gpu, scene.size);
    setRadianceScene(radiance, scene);
    await radiance.effects.emitter.compile(radiance.emitter);
    frame(gpu, (current) =>
      current.pass({ target: radiance!.emitter }, (pass) =>
        pass.draw(radiance!.effects.emitter)
      )
    );
    await gpu.settled();

    expect(radiance.emitter.size).toEqual([480, 288]);
    expect(
      uniformBindingFloats(gpu, "particle-orbit-radiance-emitter")
    ).toEqual([[0, Math.fround(480 / 288)]]);

    setRadianceTime(radiance, 7.25);
    setRadianceScene(
      radiance,
      target(gpu, { size: [500, 500], format: "rgba16float" })
    );
    frame(gpu, (current) =>
      current.pass({ target: radiance!.emitter }, (pass) =>
        pass.draw(radiance!.effects.emitter)
      )
    );
    await gpu.settled();
    expect(
      uniformBindingFloats(gpu, "particle-orbit-radiance-emitter")
    ).toEqual([[7.25, Math.fround(480 / 288)]]);
  } finally {
    if (radiance) destroyRadiance(radiance);
    gpu.dispose();
  }
});
