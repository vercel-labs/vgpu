import { afterEach, expect, test, vi } from "vitest";

import { logoPixelSize } from "./pipeline";
import { rasterizeLogo } from "./logo-raster";

function setup() {
  const drawImage = vi.fn();
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage,
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal("document", { createElement });

  let image:
    | {
        onload: (() => void) | null;
        onerror: (() => void) | null;
        src: string;
      }
    | undefined;
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        image = this;
      }
    }
  );
  return {
    canvas,
    context,
    drawImage,
    createElement,
    get image() {
      return image!;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

test("does not create browser resources for an already-aborted raster", async () => {
  const env = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(rasterizeLogo(100, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(env.createElement).not.toHaveBeenCalled();
});

test("aborts pending image work and clears its handlers", async () => {
  const env = setup();
  const controller = new AbortController();
  const raster = rasterizeLogo(100, controller.signal);
  expect(env.image.src).toContain("data:image/svg+xml");
  controller.abort();
  await expect(raster).rejects.toMatchObject({ name: "AbortError" });
  expect(env.image.src).toBe("");
  expect(env.image.onload).toBeNull();
  expect(env.image.onerror).toBeNull();
  expect(env.drawImage).not.toHaveBeenCalled();
});

test("draws the decoded logo at the exact padded dimensions and cleans handlers", async () => {
  const env = setup();
  const raster = rasterizeLogo(100);
  env.image.onload?.();
  await expect(raster).resolves.toBe(env.canvas);
  const [width, height] = logoPixelSize(100);
  expect(env.canvas.width).toBe(width + 6);
  expect(env.canvas.height).toBe(height + 6);
  expect(env.drawImage).toHaveBeenCalledWith(env.image, 3, 3, width, height);
  expect(env.context.imageSmoothingEnabled).toBe(true);
  expect(env.context.imageSmoothingQuality).toBe("high");
  expect(env.image.onload).toBeNull();
  expect(env.image.onerror).toBeNull();
});

test("surfaces decode failures after releasing image callbacks", async () => {
  const env = setup();
  const raster = rasterizeLogo(100);
  env.image.onerror?.();
  await expect(raster).rejects.toThrow(
    "Could not decode the Next.js logo SVG."
  );
  expect(env.image.onload).toBeNull();
  expect(env.image.onerror).toBeNull();
});
