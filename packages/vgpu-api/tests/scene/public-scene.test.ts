import { describe, expect, test } from "vitest";
import * as scene from "../../src/scene.ts";

const approvedRuntimeExports = [
  "box",
  "capsule",
  "composeMatrix",
  "cone",
  "cylinder",
  "degToRad",
  "disk",
  "dolly",
  "dodecahedron",
  "evaluateHierarchy",
  "fullscreenQuad",
  "geometries",
  "group",
  "hierarchyOrder",
  "icosahedron",
  "icosphere",
  "instances",
  "invertAffine",
  "localFromWorld",
  "multiplyMatrices",
  "octahedron",
  "orbit",
  "orbitRig",
  "orthographic",
  "pan",
  "perspective",
  "plane",
  "ring",
  "rigPose",
  "SceneNode",
  "smoothRig",
  "sphere",
  "srgb",
  "tetrahedron",
  "torus",
  "viewMatrices",
  "worldPerPixel",
  "zoom",
] as const;

const removedRuntimeExports = [
  "AmbientLight",
  "ambientLight",
  "DirectionalLight",
  "directionalLight",
  "LambertMaterial",
  "lambertMaterial",
  "MeshNode",
  "mesh",
  "NormalMaterial",
  "normalMaterial",
  "OrbitControls",
  "orbitControls",
  "OrthographicCamera",
  "orthographicCamera",
  "PerspectiveCamera",
  "perspectiveCamera",
  "scene",
  "ShaderMaterial",
  "shaderMaterial",
  "UnlitMaterial",
  "unlitMaterial",
] as const;

describe("vgpu/scene public surface", () => {
  test("exposes composition utilities and preserves primitive recipes", () => {
    for (const name of approvedRuntimeExports) expect(scene, name).toHaveProperty(name);
    expect(scene.box()).toMatchObject({ kind: "box" });
    expect(scene.group().kind).toBe("group");
  });

  test("does not retain the removed renderer, camera-node, or input abstractions", () => {
    for (const name of removedRuntimeExports) expect(scene, name).not.toHaveProperty(name);
    expect(scene).not.toHaveProperty("instanceGeometry");
  });
});
