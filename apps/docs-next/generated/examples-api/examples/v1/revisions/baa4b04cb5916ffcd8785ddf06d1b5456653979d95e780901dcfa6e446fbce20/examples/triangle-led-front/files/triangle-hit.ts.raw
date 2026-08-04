import { canonicalTriangleGeometry, type RenderSize } from './settings';

export interface TriangleHitPoint {
  x: number;
  y: number;
}

export function isPointInsideTriangle(
  point: TriangleHitPoint,
  size: RenderSize,
) {
  const { top, left, right } = canonicalTriangleGeometry(size);
  const side0 = signedTriangleArea(top, left, point);
  const side1 = signedTriangleArea(left, right, point);
  const side2 = signedTriangleArea(right, top, point);
  return (
    (side0 <= 0 && side1 <= 0 && side2 <= 0) ||
    (side0 >= 0 && side1 >= 0 && side2 >= 0)
  );
}

function signedTriangleArea(
  a: TriangleHitPoint,
  b: TriangleHitPoint,
  p: TriangleHitPoint,
) {
  const edgeX = b.x - a.x;
  const edgeY = b.y - a.y;
  return edgeX * (p.y - a.y) - edgeY * (p.x - a.x);
}
