import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cubeView: vi.fn(),
  geometry: vi.fn(),
}));

vi.mock("vgpu", () => ({ geometry: mocks.geometry }));
vi.mock("vgpu/core", () => ({ cubeView: mocks.cubeView }));

import { createHeroGlassAssets } from "./hero-glass-assets-core";

function mesh(magic: "HGP1" | "HGP2") {
  const stride = magic === "HGP2" ? 24 : 16;
  const vertexCount = 3;
  const indexCount = 3;
  const buffer = new ArrayBuffer(40 + vertexCount * stride + indexCount * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < magic.length; index++) {
    view.setUint8(index, magic.charCodeAt(index));
  }
  view.setUint32(4, vertexCount, true);
  view.setUint32(8, indexCount, true);
  view.setUint32(12, stride, true);
  for (let index = 0; index < 3; index++) {
    view.setFloat32(16 + index * 4, -1, true);
    view.setFloat32(28 + index * 4, 1, true);
  }
  new Uint16Array(buffer, 40 + vertexCount * stride).set([0, 1, 2]);
  return buffer;
}

function setup() {
  const resources: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  mocks.geometry.mockImplementation(() => {
    const resource = { destroy: vi.fn() };
    resources.push(resource);
    return resource;
  });
  const environment = { destroy: vi.fn(), gpu: {} };
  const gpu = {
    device: { createTexture: vi.fn(() => environment) },
    gpu: { queue: { writeTexture: vi.fn() } },
  };
  mocks.cubeView.mockReturnValue({ view: true });
  const atlas = { width: 3, height: 2, data: new Uint8Array(24) };
  return { atlas, environment, gpu, resources };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("decodes, uploads, and disposes every shared-GPU asset once", () => {
  const env = setup();
  const assets = createHeroGlassAssets(
    env.gpu as never,
    mesh("HGP1"),
    mesh("HGP2"),
    env.atlas
  );

  expect(env.resources).toHaveLength(4);
  expect(env.gpu.gpu.queue.writeTexture).toHaveBeenCalledTimes(6);
  expect(assets.environmentView).toEqual({ view: true });
  assets.dispose();
  assets.dispose();
  for (const resource of env.resources) {
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  }
  expect(env.environment.destroy).toHaveBeenCalledTimes(1);
});

test("rolls back a partially decoded mesh without masking its error", () => {
  const env = setup();
  const first = { destroy: vi.fn() };
  const failure = new Error("wireframe allocation failed");
  mocks.geometry.mockReturnValueOnce(first).mockImplementationOnce(() => {
    throw failure;
  });

  expect(() =>
    createHeroGlassAssets(
      env.gpu as never,
      mesh("HGP1"),
      mesh("HGP2"),
      env.atlas
    )
  ).toThrow(failure);
  expect(first.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.device.createTexture).not.toHaveBeenCalled();
});

test("attempts every rollback and preserves a later construction failure", () => {
  const env = setup();
  const cleanupFailure = new Error("cleanup failed");
  const constructionFailure = new Error("fractal wireframe failed");
  mocks.geometry.mockReset();
  const resources = [
    {
      destroy: vi.fn(() => {
        throw cleanupFailure;
      }),
    },
    { destroy: vi.fn() },
    { destroy: vi.fn() },
  ];
  mocks.geometry
    .mockReturnValueOnce(resources[0])
    .mockReturnValueOnce(resources[1])
    .mockReturnValueOnce(resources[2])
    .mockImplementationOnce(() => {
      throw constructionFailure;
    });

  expect(() =>
    createHeroGlassAssets(
      env.gpu as never,
      mesh("HGP1"),
      mesh("HGP2"),
      env.atlas
    )
  ).toThrow(constructionFailure);
  for (const resource of resources) {
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  }
});

test("invalid atlases and cubemap-view failures release decoded resources", () => {
  const invalid = setup();
  expect(() =>
    createHeroGlassAssets(invalid.gpu as never, mesh("HGP1"), mesh("HGP2"), {
      ...invalid.atlas,
      width: 4,
    })
  ).toThrow("packed spherical mip chain");
  for (const resource of invalid.resources) {
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  }

  vi.resetAllMocks();
  const viewFailure = setup();
  const failure = new Error("view failed");
  mocks.cubeView.mockImplementation(() => {
    throw failure;
  });
  expect(() =>
    createHeroGlassAssets(
      viewFailure.gpu as never,
      mesh("HGP1"),
      mesh("HGP2"),
      viewFailure.atlas
    )
  ).toThrow(failure);
  for (const resource of viewFailure.resources) {
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  }
  expect(viewFailure.environment.destroy).toHaveBeenCalledTimes(1);
});

test("disposal attempts every resource and reports the first cleanup error", () => {
  const env = setup();
  const assets = createHeroGlassAssets(
    env.gpu as never,
    mesh("HGP1"),
    mesh("HGP2"),
    env.atlas
  );
  const failure = new Error("solid cleanup failed");
  env.resources[0]!.destroy.mockImplementation(() => {
    throw failure;
  });
  expect(() => assets.dispose()).toThrow(failure);
  for (const resource of env.resources) {
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  }
  expect(env.environment.destroy).toHaveBeenCalledTimes(1);
});
