import type { LightWallControls } from "../../types";
import { shadowCurvePoints } from "./shadow-curve";

interface ShadowCurvePreviewProps {
  readonly wall: LightWallControls;
}

export function ShadowCurvePreview({ wall }: ShadowCurvePreviewProps) {
  const points = shadowCurvePoints(
    wall.lightmapGamma,
    wall.shadowContrast,
    wall.shadowPivot
  );
  const pivotInput = Math.pow(
    wall.shadowPivot,
    1 / Math.max(wall.lightmapGamma, 0.001)
  );

  return (
    <svg
      aria-label={`Shadow curve: gamma ${wall.lightmapGamma}, contrast ${wall.shadowContrast}, pivot ${wall.shadowPivot}`}
      className="prism-shadow-curve"
      preserveAspectRatio="none"
      role="img"
      viewBox="0 0 100 100"
    >
      <path className="prism-shadow-curve__grid" d="M0 50H100 M50 0V100" />
      <path className="prism-shadow-curve__reference" d="M0 100L100 0" />
      <line
        className="prism-shadow-curve__pivot"
        x1={pivotInput * 100}
        x2={pivotInput * 100}
        y1="0"
        y2="100"
      />
      <polyline className="prism-shadow-curve__line" points={points} />
    </svg>
  );
}
