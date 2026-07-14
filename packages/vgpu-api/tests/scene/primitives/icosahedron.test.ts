import { Mesh } from "../../../src/scene/geometry-src/index.ts";
import { test } from "vitest";
import { expectPolyhedronBasics, expectPolyhedronSnapshots } from "./_polyhedron-test-utils.ts";

const ICOSAHEDRON = { name: "icosahedron", vertexCount: 60, normalCount: 20, create: (device: Parameters<typeof Mesh.icosahedron>[0]["device"], radius: number) => Mesh.icosahedron({ device, radius }) };

test("Mesh.icosahedron creates flat indexed data", async () => {
  await expectPolyhedronBasics(ICOSAHEDRON);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("icosahedron primitive snapshot battery matches", async () => {
  await expectPolyhedronSnapshots(ICOSAHEDRON);
});
