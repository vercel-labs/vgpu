import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import {
  degToRad,
  Mesh,
  orthographicCamera,
  pbrMaterial,
  perspectiveCamera,
  RapidRenderer,
  srgb,
  type Mat4,
  type Vec3,
} from "@vgpu/render";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const SNAPSHOT_PATH = "packages/render/tests/__snapshots__/lit-cube.png";

const perspectiveExpected = [
  2.0087473392486572, -0.6495903134346008, -0.48555681109428406, -0.48507124185562134,
  0, 2.111168622970581, -0.48555681109428406, -0.48507124185562134,
  -1.3391647338867188, -0.9743854999542236, -0.7283352017402649, -0.7276068925857544,
  -1.4389834745998087e-7, -1.4389834745998087e-7, 4.027132511138916, 4.123105525970459,
];

const orthographicExpected = [
  0.41602516174316406, -0.134534552693367, -0.004855567589402199, 0,
  0, 0.43723732233047485, -0.004855567589402199, 0,
  -0.2773500978946686, -0.2018018364906311, -0.0072833518497645855, 0,
  -2.9802322387695312e-8, -2.9802322387695312e-8, 0.0402713268995285, 1,
];

function vec3(values: [number, number, number]): Vec3 {
  return new Float32Array(values) as Vec3;
}

test("cameras expose stable view-projection matrices for fixed pose", () => {
  const perspective = perspectiveCamera({
    fovYRadians: degToRad(45),
    aspect: 1,
    near: 0.1,
    far: 100,
    position: vec3([2, 2, 3]),
    target: vec3([0, 0, 0]),
  });
  const orthographic = orthographicCamera({
    left: -2,
    right: 2,
    bottom: -2,
    top: 2,
    near: 0.1,
    far: 100,
    position: vec3([2, 2, 3]),
    target: vec3([0, 0, 0]),
  });

  expectMatrixCloseTo(perspective.viewProjectionMatrix, perspectiveExpected);
  expectMatrixCloseTo(orthographic.viewProjectionMatrix, orthographicExpected);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("lit cube renders byte-equal to snapshot", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const color = device.createTexture({ size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"] });
  const depth = device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus", usage: ["render_attachment"] });

  const mesh = Mesh.box({ device, size: 1 });
  const material = pbrMaterial({ device, baseColor: srgb(0xcc8844), targetFormat: FORMAT });
  const camera = perspectiveCamera({
    fovYRadians: degToRad(45),
    aspect: 1,
    near: 0.1,
    far: 100,
    position: vec3([2, 2, 3]),
    target: vec3([0, 0, 0]),
  });

  await new RapidRenderer(device).draw({
    material,
    mesh,
    transform: rotateY(degToRad(30)),
    camera,
    light: { direction: [-1, -1, -1], color: [1, 1, 1], intensity: 1 },
    target: color.createView(),
    depthTarget: depth.createView(),
    clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
  });

  const actual = new PNG({ width: WIDTH, height: HEIGHT });
  actual.data.set(await color.read());
  const expected = PNG.sync.read(await readFile(join(process.cwd(), SNAPSHOT_PATH)));
  expect(expected.width).toBe(WIDTH);
  expect(expected.height).toBe(HEIGHT);
  const mismatched = pixelmatch(actual.data, expected.data, null, WIDTH, HEIGHT, { threshold: 0.001 });
  expect(mismatched).toBe(0);
  depth.destroy();
  color.destroy();
  device.destroy();
});

function expectMatrixCloseTo(actual: ArrayLike<number>, expected: number[]): void {
  expect(actual.length).toBe(16);
  for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, 6);
}

function rotateY(radians: number): Mat4 {
  const c = Math.cos(radians), s = Math.sin(radians);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]) as Mat4;
}
