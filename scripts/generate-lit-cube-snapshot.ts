import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { degToRad, Mesh, pbrMaterial, perspectiveCamera, RapidRenderer, srgb, type Mat4, type Vec3 } from "@vgpu/render";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const outputPath = join(process.cwd(), "packages/render/tests/__snapshots__/lit-cube.png");

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
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

  material.writeUniforms({
    viewProjection: camera.viewProjectionMatrix,
    model: rotateY(degToRad(30)),
    cameraPosition: camera.position,
    light: { direction: [-1, -1, -1], color: [1, 1, 1], intensity: 1 },
  });

  await new RapidRenderer(device).draw({
    material,
    mesh,
    target: color.createView(),
    depthTarget: depth.createView(),
    clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
  });

  const png = new PNG({ width: WIDTH, height: HEIGHT });
  png.data.set(await color.read());
  const encoded = PNG.sync.write(png);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, encoded);
  console.log(`wrote ${outputPath}`);
  console.log(`size ${encoded.byteLength} bytes`);
  console.log(`sha256 ${createHash("sha256").update(encoded).digest("hex")}`);

  depth.destroy();
  color.destroy();
  device.destroy();
}

function vec3(values: [number, number, number]): Vec3 {
  return new Float32Array(values) as Vec3;
}

function rotateY(radians: number): Mat4 {
  const c = Math.cos(radians), s = Math.sin(radians);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]) as Mat4;
}
