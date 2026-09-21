import * as THREE from "three/webgpu";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { createObjectDragControls } from "./object-drag-controls.ts";
import { createDemoCamera, createDemoScene, DEMO_MESH_KINDS, type DemoMeshKind } from "./scenes.ts";

async function main(): Promise<void> {
  if (navigator.gpu === undefined) {
    document.querySelector("#overlay")!.textContent = "WebGPU is not available in this browser.";
    return;
  }

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 1), 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.querySelector("#app")!.append(renderer.domElement);
  await renderer.init();

  const demo = await createDemoScene({ renderer });
  const { scene } = demo;
  const camera = createDemoCamera(window.innerWidth / window.innerHeight);

  const gui = new GUI({ title: "lava" });
  const settings: { mesh: DemoMeshKind } = { mesh: "sphere" };
  gui
    .add(settings, "mesh", [...DEMO_MESH_KINDS])
    .onChange((kind: DemoMeshKind) => demo.setMesh(kind));

  const controls = createObjectDragControls(
    camera,
    demo.rotationRoot,
    renderer.domElement
  );

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop((time) => {
    controls.update(time);
    renderer.render(scene, camera);
  });
}

void main();
