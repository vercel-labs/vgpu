/**
 * The machine's layout as plain data, shared by the physics world and the
 * renderer so the bodies the marbles roll on are exactly the boxes on screen.
 *
 * Units are decimetres (1 unit = 10 cm): the machine is about 5.7 units wide
 * and 4.8 tall, a 57 cm desk toy. y is up, z points at the viewer.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** Surface shading in solids.wgsl; keep in sync with the MATERIAL_* constants there. */
export const MATERIAL = {
  maple: 0,
  walnut: 1,
  brass: 2,
  felt: 3,
  slate: 4,
  studio: 5,
} as const;

export type MaterialName = keyof typeof MATERIAL;

/** Physical contact class; null parts are decoration with no body. */
export type Contact = 'wood' | 'felt' | 'brass' | null;

export interface BoxPart {
  readonly name: string;
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  readonly quaternion: Quat;
  readonly material: MaterialName;
  readonly contact: Contact;
}

export interface TrimPart {
  readonly name: string;
  readonly center: Vec3;
  readonly radius: number;
  readonly height: number;
  /** Cylinder axis; the recipe's own axis is y. */
  readonly axis: 'y' | 'z';
  readonly material: MaterialName;
}

export interface Ramp {
  /** +1 rolls toward +x, -1 toward -x. */
  readonly direction: 1 | -1;
  readonly highX: number;
  readonly lowX: number;
  readonly highY: number;
  readonly lowY: number;
}

export const MARBLE_RADIUS = 0.15;

const TROUGH_WIDTH = 0.42;
const FLOOR_THICKNESS = 0.08;
const RAIL_THICKNESS = 0.05;
const RAIL_HEIGHT = 0.19;
const SLOPE = (5.5 * Math.PI) / 180;
const DROP_GAP = 0.62;
const RAMP_TOP = 4.13;
const RAMP_SPACING = 0.95;
const RAMP_COUNT = 4;

const UPRIGHT_X = 2.7;
const UPRIGHT_HALF_WIDTH = 0.15;
/** Inner faces of the uprights; every ramp runs between them. */
export const INNER_X = UPRIGHT_X - UPRIGHT_HALF_WIDTH;

const BACKBOARD_FRONT = -0.3;
const TRAY_BACK = -0.24;
const TRAY_FRONT = 1.25;
const TRAY_HALF_X = 2.45;
const TRAY_WALL = 0.06;

export const HOPPER_X = -2.27;
export const HOPPER_INNER = 0.2;
export const SPAWN_Y = 4.62;

const IDENTITY: Quat = [0, 0, 0, 1];

function aroundZ(angle: number): Quat {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

function aroundX(angle: number): Quat {
  return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}

/** Hamilton product a ⊗ b: rotate by b, then by a. */
function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function add(a: Vec3, b: Vec3, scale = 1): Vec3 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

export const RAMPS: readonly Ramp[] = Array.from({ length: RAMP_COUNT }, (_, index) => {
  const direction = index % 2 === 0 ? 1 : -1;
  const highX = -direction * INNER_X;
  const lowX = direction * (INNER_X - DROP_GAP);
  const highY = RAMP_TOP - index * RAMP_SPACING;
  return { direction, highX, lowX, highY, lowY: highY - Math.abs(lowX - highX) * Math.tan(SLOPE) };
});

/** Floor top height of a ramp at x, for tests and the camera. */
export function rampSurfaceY(ramp: Ramp, x: number): number {
  return ramp.highY - Math.abs(x - ramp.highX) * Math.tan(SLOPE);
}

function rampParts(ramp: Ramp, index: number): BoxPart[] {
  const { direction } = ramp;
  const quaternion = aroundZ(-direction * SLOPE);
  // Up-facing normal of the tilted floor.
  const normal: Vec3 = [direction * Math.sin(SLOPE), Math.cos(SLOPE), 0];
  const top: Vec3 = [(ramp.highX + ramp.lowX) / 2, (ramp.highY + ramp.lowY) / 2, 0];
  const halfLength = Math.abs(ramp.lowX - ramp.highX) / (2 * Math.cos(SLOPE));
  const outerZ = TROUGH_WIDTH / 2 + RAIL_THICKNESS;
  const railZ = TROUGH_WIDTH / 2 + RAIL_THICKNESS / 2;
  const railCenter = add(top, normal, (RAIL_HEIGHT - FLOOR_THICKNESS) / 2);
  const railHalf: Vec3 = [halfLength, (RAIL_HEIGHT + FLOOR_THICKNESS) / 2, RAIL_THICKNESS / 2];
  const parts: BoxPart[] = [
    {
      name: `ramp-${index}-floor`,
      // The top is the rolling surface. The rest is tucked inside the rails, a hair short of
      // their ends and bottoms, so no face shares a plane with a rail face and nothing z-fights.
      center: add(top, normal, -(FLOOR_THICKNESS / 2 - 0.002)),
      halfExtents: [halfLength - 0.003, FLOOR_THICKNESS / 2 - 0.002, TROUGH_WIDTH / 2 + RAIL_THICKNESS / 2],
      quaternion,
      material: 'maple',
      contact: 'wood',
    },
    { name: `ramp-${index}-rail-back`, center: [railCenter[0], railCenter[1], -railZ], halfExtents: railHalf, quaternion, material: 'maple', contact: 'wood' },
    { name: `ramp-${index}-rail-front`, center: [railCenter[0], railCenter[1], railZ], halfExtents: railHalf, quaternion, material: 'maple', contact: 'wood' },
  ];
  // Brass mounting plates behind the back rail tie the ramp to the backboard.
  for (const along of [-0.62, 0, 0.62]) {
    const center = add(add(top, rotate(quaternion, [1, 0, 0]), along * halfLength), normal, 0.02);
    parts.push({
      name: `ramp-${index}-mount-${along}`,
      center: [center[0], center[1], (BACKBOARD_FRONT - outerZ) / 2 - 0.004],
      halfExtents: [0.07, 0.11, (outerZ + BACKBOARD_FRONT) / -2 + 0.006],
      quaternion,
      material: 'brass',
      contact: null,
    });
  }
  return parts;
}

function trayParts(): BoxPart[] {
  // The felt floor tilts toward the front-right corner so the catch collects
  // against the front lip, in full view and out from under the ramps.
  const frontTilt = (3.5 * Math.PI) / 180;
  const sideTilt = (1 * Math.PI) / 180;
  const quaternion = multiply(aroundZ(-sideTilt), aroundX(frontTilt));
  const normal = rotate(quaternion, [0, 1, 0]);
  const centerZ = (TRAY_BACK + TRAY_FRONT) / 2;
  const floorThickness = 0.06;
  const halfZ = (TRAY_FRONT - TRAY_BACK) / 2 + TRAY_WALL;
  const wallX = TRAY_HALF_X + TRAY_WALL / 2;
  return [
    {
      name: 'tray-floor',
      center: add([0, 0.16, centerZ], normal, -floorThickness / 2),
      // Ends halfway into the walls, so the tilted felt never pokes out of their outer faces.
      halfExtents: [TRAY_HALF_X + TRAY_WALL / 2, floorThickness / 2, halfZ - TRAY_WALL / 2],
      quaternion,
      material: 'felt',
      contact: 'felt',
    },
    { name: 'tray-back', center: [0, 0.23, TRAY_BACK - TRAY_WALL / 2], halfExtents: [TRAY_HALF_X + TRAY_WALL, 0.23, TRAY_WALL / 2], quaternion: IDENTITY, material: 'maple', contact: 'wood' },
    { name: 'tray-front', center: [0, 0.18, TRAY_FRONT + TRAY_WALL / 2], halfExtents: [TRAY_HALF_X + TRAY_WALL, 0.18, TRAY_WALL / 2], quaternion: IDENTITY, material: 'maple', contact: 'wood' },
    { name: 'tray-left', center: [-wallX, 0.23, centerZ], halfExtents: [TRAY_WALL / 2, 0.23, halfZ], quaternion: IDENTITY, material: 'maple', contact: 'wood' },
    { name: 'tray-right', center: [wallX, 0.23, centerZ], halfExtents: [TRAY_WALL / 2, 0.23, halfZ], quaternion: IDENTITY, material: 'maple', contact: 'wood' },
  ];
}

function hopperParts(): BoxPart[] {
  const wall = 0.03;
  const offset = HOPPER_INNER + wall / 2;
  const bottom = 4.4;
  const top = 4.82;
  const y = (bottom + top) / 2;
  const half = (top - bottom) / 2;
  const span = HOPPER_INNER + wall;
  const lipTop = SPAWN_Y - 0.08;
  return [
    { name: 'hopper-left', center: [HOPPER_X - offset, y, 0], halfExtents: [wall / 2, half, span], quaternion: IDENTITY, material: 'brass', contact: 'brass' },
    { name: 'hopper-right', center: [HOPPER_X + offset, y, 0], halfExtents: [wall / 2, half, span], quaternion: IDENTITY, material: 'brass', contact: 'brass' },
    { name: 'hopper-back', center: [HOPPER_X, y, -offset], halfExtents: [HOPPER_INNER, half, wall / 2], quaternion: IDENTITY, material: 'brass', contact: 'brass' },
    // A low front lip, so the waiting marble shows (even while paused) above it.
    { name: 'hopper-front', center: [HOPPER_X, (bottom + lipTop) / 2, offset], halfExtents: [HOPPER_INNER, (lipTop - bottom) / 2, wall / 2], quaternion: IDENTITY, material: 'brass', contact: 'brass' },
    // Arm from the hopper to the upright.
    { name: 'hopper-arm', center: [(-INNER_X + HOPPER_X - offset) / 2, 4.7, -0.1], halfExtents: [(HOPPER_X - offset + INNER_X) / 2, 0.03, 0.03], quaternion: IDENTITY, material: 'brass', contact: null },
  ];
}

export const BOX_PARTS: readonly BoxPart[] = [
  { name: 'studio-floor', center: [0, -0.62, 0], halfExtents: [60, 0.1, 60], quaternion: IDENTITY, material: 'studio', contact: null },
  { name: 'plinth', center: [0, -0.2, 0.45], halfExtents: [3.3, 0.2, 1.15], quaternion: IDENTITY, material: 'slate', contact: 'wood' },
  { name: 'backboard', center: [0, 2.3, -0.36], halfExtents: [UPRIGHT_X + UPRIGHT_HALF_WIDTH, 2.3, 0.06], quaternion: IDENTITY, material: 'walnut', contact: 'wood' },
  { name: 'upright-left', center: [-UPRIGHT_X, 2.45, 0.03], halfExtents: [UPRIGHT_HALF_WIDTH, 2.45, 0.33], quaternion: IDENTITY, material: 'walnut', contact: 'wood' },
  { name: 'upright-right', center: [UPRIGHT_X, 2.45, 0.03], halfExtents: [UPRIGHT_HALF_WIDTH, 2.45, 0.33], quaternion: IDENTITY, material: 'walnut', contact: 'wood' },
  ...RAMPS.flatMap(rampParts),
  ...trayParts(),
  ...hopperParts(),
];

export const TRIM_PARTS: readonly TrimPart[] = [
  // Feet under the plinth.
  ...[-3, 3].flatMap((x) =>
    [-0.5, 1.4].map((z): TrimPart => ({ name: `foot-${x}-${z}`, center: [x, -0.46, z], radius: 0.16, height: 0.12, axis: 'y', material: 'brass' })),
  ),
  // Brass bolts on the upright fronts, one where each ramp end meets an upright.
  ...RAMPS.flatMap((ramp, index) => [
    { name: `bolt-${index}-high`, center: [Math.sign(ramp.highX) * UPRIGHT_X, ramp.highY - 0.06, 0.375], radius: 0.045, height: 0.03, axis: 'z', material: 'brass' } satisfies TrimPart,
    { name: `bolt-${index}-low`, center: [Math.sign(ramp.lowX) * UPRIGHT_X, ramp.lowY - 0.1, 0.375], radius: 0.035, height: 0.03, axis: 'z', material: 'brass' } satisfies TrimPart,
  ]),
  // Upright caps.
  ...[-UPRIGHT_X, UPRIGHT_X].map((x): TrimPart => ({ name: `cap-${x}`, center: [x, 4.93, 0.03], radius: 0.12, height: 0.06, axis: 'y', material: 'brass' })),
];

/** Bounds used to fit the camera: the machine without the studio floor. */
export const MACHINE_BOUNDS = { min: [-3.3, -0.52, -0.7] as Vec3, max: [3.3, 4.99, 1.6] as Vec3 };

/** Bodies leaving this box are removed from the world. */
export const WORLD_LIMITS = { min: [-4.5, -1.5, -2.5] as Vec3, max: [4.5, 7, 3.5] as Vec3 };
