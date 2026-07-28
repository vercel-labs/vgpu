import type { SceneGeometry } from "../geometry.ts";
import { normalMaterial, type SceneMaterial } from "./material.ts";
import { SceneNode, type NodeOptions } from "./node.ts";

/**
 * Renderable node: a pure geometry descriptor paired with a material. `geometry` and
 * `material` are swappable; the renderer re-keys its caches by identity.
 */
export class MeshNode extends SceneNode {
  geometry: SceneGeometry;
  material: SceneMaterial;

  constructor(geometry: SceneGeometry, material?: SceneMaterial, options: NodeOptions = {}) {
    super("mesh", options);
    this.geometry = geometry;
    this.material = material ?? normalMaterial();
  }
}

/** Creates a renderable mesh node. Without a material it defaults to `normalMaterial()`. */
export function mesh(geometry: SceneGeometry, material?: SceneMaterial, options: NodeOptions = {}): MeshNode {
  return new MeshNode(geometry, material, options);
}

/** Root node factory. Any node can be a root; `scene()` names the intent. */
export function scene(options: NodeOptions = {}): SceneNode {
  return new SceneNode("scene", options);
}
