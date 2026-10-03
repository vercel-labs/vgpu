import { mat4 } from "math";

const HANDLE_STRIDE = 0x1_0000;

export function createWorld({ capacity = 64 } = {}) {
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity >= HANDLE_STRIDE) {
    throw new TypeError("capacity must be an integer between 1 and 65535");
  }

  const alive = new Uint8Array(capacity);
  const generations = new Uint16Array(capacity);
  const parents = new Int32Array(capacity).fill(-1);
  const children = Array.from({ length: capacity }, () => new Set());
  const positions = new Array(capacity);
  const rotations = new Array(capacity);
  const scales = new Array(capacity);
  const renderables = new Array(capacity).fill(null);
  const cameras = new Array(capacity).fill(null);
  const localDirty = new Uint8Array(capacity);
  const worldDirty = new Uint8Array(capacity);
  const localMatrices = new Float32Array(capacity * 16);
  const worldMatrices = new Float32Array(capacity * 16);
  const worldVersion = new Uint32Array(capacity);
  const free = [];
  let nextRow = 0;

  function handleOf(row) {
    return generations[row] * HANDLE_STRIDE + row;
  }

  function requireRow(handle) {
    if (!Number.isInteger(handle) || handle < 0) throw new TypeError("handle must name a live entity");
    const row = handle % HANDLE_STRIDE;
    const generation = Math.floor(handle / HANDLE_STRIDE);
    if (row >= capacity || !alive[row] || generations[row] !== generation) {
      throw new TypeError(`handle ${handle} is stale or does not name a live entity`);
    }
    return row;
  }

  function copyVector(value, length, label) {
    if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
      throw new TypeError(`${label} must contain ${length} finite numbers`);
    }
    return [...value];
  }

  function copyRenderable(value) {
    if (value == null) return null;
    return {
      size: copyVector(value.size, 3, "renderable.size"),
      offset: copyVector(value.offset, 3, "renderable.offset"),
      color: copyVector(value.color, 3, "renderable.color"),
    };
  }

  function copyCamera(value) {
    if (value == null) return null;
    const result = {};
    for (const field of ["left", "right", "bottom", "top", "near", "far"]) {
      if (!Number.isFinite(value[field])) throw new TypeError(`camera.${field} must be finite`);
      result[field] = value[field];
    }
    return result;
  }

  function markWorldDirty(row) {
    worldDirty[row] = 1;
    for (const child of children[row]) markWorldDirty(child);
  }

  function spawn(spec) {
    const parentRow = spec.parent == null ? -1 : requireRow(spec.parent);
    const row = free.length > 0 ? free.pop() : nextRow++;
    if (row >= capacity) {
      nextRow = capacity;
      throw new RangeError(`world capacity ${capacity} is exhausted`);
    }
    alive[row] = 1;
    parents[row] = parentRow;
    positions[row] = copyVector(spec.position, 3, "position");
    rotations[row] = copyVector(spec.rotation, 4, "rotation");
    scales[row] = copyVector(spec.scale, 3, "scale");
    renderables[row] = copyRenderable(spec.renderable);
    cameras[row] = copyCamera(spec.camera);
    children[row].clear();
    if (parentRow !== -1) children[parentRow].add(row);
    localDirty[row] = 1;
    worldDirty[row] = 1;
    return handleOf(row);
  }

  function setLocal(handle, field, value, length) {
    const row = requireRow(handle);
    const copied = copyVector(value, length, field);
    if (field === "position") positions[row] = copied;
    else if (field === "rotation") rotations[row] = copied;
    else scales[row] = copied;
    localDirty[row] = 1;
    markWorldDirty(row);
  }

  function setParent(handle, parent) {
    const row = requireRow(handle);
    const parentRow = parent == null ? -1 : requireRow(parent);
    if (parentRow === row) throw new TypeError("an entity cannot parent itself");
    for (let ancestor = parentRow; ancestor !== -1; ancestor = parents[ancestor]) {
      if (ancestor === row) throw new TypeError("parenting would create a cycle");
    }
    const previous = parents[row];
    if (previous === parentRow) return;
    if (previous !== -1) children[previous].delete(row);
    parents[row] = parentRow;
    if (parentRow !== -1) children[parentRow].add(row);
    markWorldDirty(row);
  }

  function despawn(handle) {
    const root = requireRow(handle);
    const remove = (row) => {
      for (const child of [...children[row]]) remove(child);
      const parent = parents[row];
      if (parent !== -1) children[parent].delete(row);
      children[row].clear();
      parents[row] = -1;
      positions[row] = undefined;
      rotations[row] = undefined;
      scales[row] = undefined;
      renderables[row] = null;
      cameras[row] = null;
      localDirty[row] = 0;
      worldDirty[row] = 0;
      alive[row] = 0;
      generations[row] = (generations[row] + 1) & 0xffff;
      free.push(row);
    };
    remove(root);
  }

  function update() {
    const visited = new Uint8Array(capacity);
    const changed = new Uint8Array(capacity);
    const visit = (row) => {
      if (!alive[row] || visited[row]) return;
      const parent = parents[row];
      if (parent !== -1) visit(parent);
      const local = localMatrices.subarray(row * 16, row * 16 + 16);
      const world = worldMatrices.subarray(row * 16, row * 16 + 16);
      if (localDirty[row]) {
        mat4.fromRotationTranslationScale(local, rotations[row], positions[row], scales[row]);
        localDirty[row] = 0;
      }
      if (worldDirty[row]) {
        if (parent === -1) world.set(local);
        else mat4.multiply(world, worldMatrices.subarray(parent * 16, parent * 16 + 16), local);
        worldDirty[row] = 0;
        worldVersion[row] += 1;
        changed[row] = 1;
      }
      visited[row] = 1;
    };
    for (let row = 0; row < nextRow; row += 1) visit(row);
    const rows = [];
    for (let row = 0; row < nextRow; row += 1) if (changed[row]) rows.push(row);
    return rows;
  }

  return Object.freeze({
    localMatrices,
    worldMatrices,
    worldVersion,
    spawn,
    despawn,
    update,
    setPosition(handle, value) { setLocal(handle, "position", value, 3); },
    setRotation(handle, value) { setLocal(handle, "rotation", value, 4); },
    setScale(handle, value) { setLocal(handle, "scale", value, 3); },
    setParent,
    isAlive(handle) {
      if (!Number.isInteger(handle) || handle < 0) return false;
      const row = handle % HANDLE_STRIDE;
      return row < capacity && Boolean(alive[row]) && generations[row] === Math.floor(handle / HANDLE_STRIDE);
    },
    rowOf: requireRow,
    parentOf(handle) {
      const parent = parents[requireRow(handle)];
      return parent === -1 ? null : handleOf(parent);
    },
    renderable(handle) { return renderables[requireRow(handle)]; },
    camera(handle) { return cameras[requireRow(handle)]; },
    entities() {
      const result = [];
      for (let row = 0; row < nextRow; row += 1) if (alive[row]) result.push(handleOf(row));
      return result;
    },
  });
}
