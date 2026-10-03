const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function identity4() {
  return [...IDENTITY];
}

export function translation(position) {
  const out = identity4();
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  return out;
}

export function rotationZ(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function scale4(scale) {
  return [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1];
}

export function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

export function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
  ];
}

export function orthographic({ left, right, bottom, top, near, far }) {
  return [
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, 1 / (near - far), 0,
    (right + left) / (left - right), (top + bottom) / (bottom - top), near / (near - far), 1,
  ];
}

export function viewProjection(cameraPosition, bounds) {
  const [left, right, bottom, top, near, far] = bounds;
  return multiply4(
    orthographic({ left, right, bottom, top, near, far }),
    translation(cameraPosition.map((value) => -value)),
  );
}

export function projectPoint(point, { width, height, cameraPosition, bounds }) {
  const clip = transformPoint(viewProjection(cameraPosition, bounds), point);
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return [width * (ndcX + 1) / 2, height * (1 - ndcY) / 2, clip[2] / clip[3]];
}

export function robotJoints(frame) {
  const base = multiply4(translation(frame.basePosition), rotationZ(frame.baseAngle));
  const shoulder = multiply4(multiply4(base, translation([0, 0.35, 0])), rotationZ(frame.shoulderAngle));
  const elbow = multiply4(multiply4(shoulder, translation([1.5, 0, 0])), rotationZ(frame.elbowAngle));
  const wrist = multiply4(multiply4(elbow, translation([1.1, 0, 0])), rotationZ(frame.wristAngle));
  const tip = multiply4(wrist, translation([0.5, 0, 0]));
  return { base, shoulder, elbow, wrist, tip };
}

export function matrixWithBox(joint, center, dimensions) {
  return multiply4(multiply4(joint, translation(center)), scale4(dimensions));
}

export function projectedRectangle(matrix, projectionOptions) {
  return [
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ].map((point) => projectPoint(transformPoint(matrix, point), projectionOptions).slice(0, 2));
}

export function containsConvexPoint(polygon, point, edgeBand = 0) {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const edgeX = b[0] - a[0];
    const edgeY = b[1] - a[1];
    const cross = edgeX * (point[1] - a[1]) - edgeY * (point[0] - a[0]);
    const distance = Math.abs(cross) / Math.hypot(edgeX, edgeY);
    if (distance < edgeBand) return false;
    const current = Math.sign(cross);
    if (current === 0) continue;
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

export function applyWarehouseFrames(items, frames) {
  const live = new Map(items.map((item) => [item.appId, structuredClone(item)]));
  return frames.map((frame) => {
    for (const operation of frame.operations) {
      if (operation.op === "delete") live.delete(operation.appId);
      else {
        const current = live.get(operation.appId);
        if (!current) throw new Error(`warehouse operation references missing appId ${operation.appId}`);
        if (operation.op === "move") current.position = [...operation.position];
        else if (operation.op === "recolor") current.tint = [...operation.tint];
      }
    }
    const sorted = [...live.values()].map((item) => structuredClone(item)).sort((a, b) => a.appId - b.appId);
    return { count: sorted.length, items: sorted };
  });
}

export function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}
