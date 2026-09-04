export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Top-origin viewport coordinates normalized to the canvas. */
export interface NormalizedViewport {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Bounds in WebGPU normalized device coordinates. */
export interface NdcBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Uniform clip-space scale followed by a principal-point offset. */
export interface ProjectionFraming {
  readonly scale: number;
  readonly offset: readonly [number, number];
}

export interface ProjectionDistanceFit {
  readonly distance: number;
  readonly bounds: NdcBounds;
  readonly framing: ProjectionFraming;
}

export const IDENTITY_PROJECTION_FRAMING: ProjectionFraming = Object.freeze({
  scale: 1,
  offset: Object.freeze([0, 0]) as readonly [number, number],
});

/**
 * Resolves a target element inside a canvas using CSS pixels.
 *
 * Ratios make the result independent of DPR, while intersecting both rects
 * prevents a transient layout outside the canvas from producing invalid NDC.
 */
export function viewportWithinCanvas(
  canvas: RectLike,
  target: RectLike
): NormalizedViewport | undefined {
  if (!(canvas.width > 0) || !(canvas.height > 0)) return undefined;
  const left = clamp(target.left - canvas.left, 0, canvas.width);
  const top = clamp(target.top - canvas.top, 0, canvas.height);
  const right = clamp(
    target.left + target.width - canvas.left,
    0,
    canvas.width
  );
  const bottom = clamp(
    target.top + target.height - canvas.top,
    0,
    canvas.height
  );
  if (right - left < 1 || bottom - top < 1) return undefined;
  return {
    left: left / canvas.width,
    top: top / canvas.height,
    right: right / canvas.width,
    bottom: bottom / canvas.height,
  };
}

/** Projects world-space points and returns their NDC bounding box. */
export function projectedBounds(
  matrices: readonly Float32Array[],
  points: readonly (readonly [number, number, number])[]
): NdcBounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const matrix of matrices) {
    for (const [x, y, z] of points) {
      const clipX =
        matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
      const clipY =
        matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
      const clipW =
        matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
      if (!Number.isFinite(clipW) || Math.abs(clipW) < 1e-6) continue;
      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      x0 = Math.min(x0, ndcX);
      y0 = Math.min(y0, ndcY);
      x1 = Math.max(x1, ndcX);
      y1 = Math.max(y1, ndcY);
    }
  }
  if (![x0, y0, x1, y1].every(Number.isFinite)) {
    return { x0: -1, y0: -1, x1: 1, y1: 1 };
  }
  return { x0, y0, x1, y1 };
}

/** Aligns the centre of the projected silhouette with the DOM slot. */
export function alignProjection(
  bounds: NdcBounds,
  viewport: NormalizedViewport
): ProjectionFraming {
  return {
    scale: 1,
    offset: [
      viewport.left + viewport.right - 1 - (bounds.x0 + bounds.x1) / 2,
      1 - viewport.top - viewport.bottom - (bounds.y0 + bounds.y1) / 2,
    ],
  };
}

/**
 * Starts close to the prism and backs the camera away until the projected
 * silhouette fits the viewport. With no artificial padding, either its width
 * or height lands exactly on the slot boundary.
 */
export function fitProjectionDistance(
  viewport: NormalizedViewport,
  boundsAtDistance: (distance: number) => NdcBounds,
  minDistance: number,
  maxDistance: number,
  iterations = 36
): ProjectionDistanceFit {
  let near = Math.max(1e-4, minDistance);
  let far = Math.max(near, maxDistance);
  let bounds = boundsAtDistance(far);
  // Preserve containment even if a future geometry/FOV combination exceeds
  // the initial search range.
  for (
    let attempt = 0;
    attempt < 8 && !fitsViewport(bounds, viewport);
    attempt++
  ) {
    far *= 2;
    bounds = boundsAtDistance(far);
  }
  for (let step = 0; step < iterations; step++) {
    const distance = (near + far) / 2;
    const candidate = boundsAtDistance(distance);
    if (fitsViewport(candidate, viewport)) {
      far = distance;
      bounds = candidate;
    } else {
      near = distance;
    }
  }
  return {
    distance: far,
    bounds,
    framing: alignProjection(bounds, viewport),
  };
}

/** Left-multiplies a view-projection by a scale/translation in clip space. */
export function applyProjectionFraming(
  viewProjection: Float32Array,
  framing: ProjectionFraming
): Float32Array {
  if (
    framing.scale === IDENTITY_PROJECTION_FRAMING.scale &&
    framing.offset[0] === 0 &&
    framing.offset[1] === 0
  ) {
    return viewProjection;
  }
  const result = new Float32Array(viewProjection);
  for (let column = 0; column < 4; column++) {
    const row = column * 4;
    const w = viewProjection[row + 3]!;
    result[row] = viewProjection[row]! * framing.scale + w * framing.offset[0];
    result[row + 1] =
      viewProjection[row + 1]! * framing.scale + w * framing.offset[1];
  }
  return result;
}

/**
 * How much farther a centred wall must extend so the shifted projection still
 * covers every canvas edge. Values never shrink the existing safety margin.
 */
export function framingCoverage(
  framing: ProjectionFraming
): readonly [number, number] {
  const scale = Math.max(framing.scale, 1e-4);
  return [
    Math.max(1, (1 + Math.abs(framing.offset[0])) / scale),
    Math.max(1, (1 + Math.abs(framing.offset[1])) / scale),
  ];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function fitsViewport(
  bounds: NdcBounds,
  viewport: NormalizedViewport
): boolean {
  const availableWidth = (viewport.right - viewport.left) * 2;
  const availableHeight = (viewport.bottom - viewport.top) * 2;
  return (
    bounds.x1 - bounds.x0 <= availableWidth &&
    bounds.y1 - bounds.y0 <= availableHeight
  );
}
