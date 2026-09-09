import type { Node } from "three/webgpu";
import { positionLocal } from "three/tsl";
import { isShaderFunctionExport, type ShaderFunctionExport } from "vgpu";
import type { ShaderSource } from "vgpu/client";
import { tslExports, type TslExportsErrorCode } from "vgpu/three";
import surfaceModule from "./surface.wgsl";

const source = `
fn surfaceColor(position: vec3f, timeSeconds: f32) -> vec3f {
  return position * timeSeconds;
}

fn surfaceRoughness(position: vec3f, timeSeconds: f32) -> f32 {
  return length(position) * timeSeconds;
}
`;

const sourceInvalidCode: TslExportsErrorCode =
  "VGPU-THREE-TSL-SOURCE-INVALID";
void sourceInvalidCode;

const inferred = tslExports(source)("surfaceColor", "surfaceRoughness");
inferred.surfaceColor({ position: positionLocal, timeSeconds: 1 });

// @ts-expect-error — only requested literal names are returned.
inferred.unselected({ position: positionLocal, timeSeconds: 1 });

interface SurfaceExports {
  surfaceColor: {
    position: Node;
    timeSeconds: Node | number;
  };
  surfaceRoughness: {
    position: Node;
    timeSeconds: Node | number;
  };
}

const typed = tslExports<SurfaceExports>(source)(
  "surfaceColor",
  "surfaceRoughness",
);

typed.surfaceColor({ position: positionLocal, timeSeconds: 1 });

const selected = tslExports<SurfaceExports>(source)("surfaceColor");
selected.surfaceColor({ position: positionLocal, timeSeconds: 1 });

// @ts-expect-error — manual contracts expose only the selected export keys.
selected.surfaceRoughness({ position: positionLocal, timeSeconds: 1 });

declare const selectedName: keyof SurfaceExports;
const selectedByUnion = tslExports<SurfaceExports>(source)(selectedName);

// @ts-expect-error — a union-valued name cannot guarantee surfaceColor was selected.
selectedByUnion.surfaceColor({ position: positionLocal, timeSeconds: 1 });
if ("surfaceColor" in selectedByUnion) {
  selectedByUnion.surfaceColor({ position: positionLocal, timeSeconds: 1 });
}

declare const maybeNames: [] | ["surfaceColor"];
const selectedByTupleUnion = tslExports<SurfaceExports>(source)(...maybeNames);

// @ts-expect-error — a union tuple may select no functions.
selectedByTupleUnion.surfaceColor({ position: positionLocal, timeSeconds: 1 });

declare const dynamicNames: Array<keyof SurfaceExports>;
const dynamicallySelected = tslExports<SurfaceExports>(source)(...dynamicNames);

// @ts-expect-error — a widened selection cannot guarantee a key is present.
dynamicallySelected.surfaceColor({ position: positionLocal, timeSeconds: 1 });
dynamicallySelected.surfaceColor?.({ position: positionLocal, timeSeconds: 1 });

// @ts-expect-error — selector names are positional; arrays must be spread.
tslExports<SurfaceExports>(source)(["surfaceColor"]);

// @ts-expect-error — selected names must belong to the manual contract.
tslExports<SurfaceExports>(source)("surfaceColour");

// @ts-expect-error — timeSeconds is required by the manual contract.
typed.surfaceColor({ position: positionLocal });

// @ts-expect-error — unknown inputs are rejected by the manual contract.
typed.surfaceColor({ position: positionLocal, timeSeconds: 1, extra: 1 });

// @ts-expect-error — the manual contract accepts only its declared value types.
typed.surfaceColor({ position: positionLocal, timeSeconds: "now" });

const surfaceColorExport: ShaderFunctionExport = {
  name: "surfaceColor",
  resolvedName: "surfaceColor",
  parameterNames: ["position", "timeSeconds"],
};
const publicArtifact: ShaderSource = {
  version: 1,
  wgsl: source,
  functionExports: [surfaceColorExport],
};
const importedExports: readonly ShaderFunctionExport[] | undefined =
  surfaceModule.functionExports;
const unknownExport: unknown = surfaceColorExport;
if (!isShaderFunctionExport(unknownExport)) {
  throw new Error("expected shader function export metadata");
}
const narrowedExport: ShaderFunctionExport = unknownExport;

tslExports(publicArtifact)("surfaceColor");
tslExports(surfaceModule)("surfaceColor");
void importedExports;
void narrowedExport;
