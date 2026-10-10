import {
  composeMatrix,
  group,
  instances,
  orbit,
  orbitRig,
  perspective,
  type Lens,
  type Mat4,
  type QuatLike,
  type SceneNodeKind,
  type Vec3Like,
} from "vgpu/scene";
import { instanceGeometry, type InstanceGeometry } from "vgpu/scene/gpu";

const kind: SceneNodeKind = "group";
const vector: Vec3Like = [1, 2, 3];
const quaternion: QuatLike = [0, 0, 0, 1];
const matrix: Mat4 = composeMatrix({ position: vector, quaternion }, new Float32Array(16));
const lens: Lens = { fov: 45, near: 0.1, far: 100 };

group({ position: vector });
instances({ capacity: 0 });
perspective(lens, 1, matrix);
orbit(orbitRig(), 0.1, -0.2);

declare const bridge: InstanceGeometry;
declare const factory: typeof instanceGeometry;
void [kind, bridge, factory];

// @ts-expect-error only material-independent group nodes remain.
const removedKind: SceneNodeKind = "mesh";
// @ts-expect-error orbit now mutates an explicit rig rather than returning an object matrix from time.
orbit(1, { radius: 2 });
// @ts-expect-error camera construction is split into explicit pose, lens, projection, and matrix functions.
import("vgpu/scene").then(({ perspectiveCamera }) => perspectiveCamera({ fov: 45 }));
// @ts-expect-error the GPU bridge is available only from vgpu/scene/gpu.
import("vgpu/scene").then(({ instanceGeometry }) => instanceGeometry);

void removedKind;
