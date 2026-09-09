import * as THREE from "three/webgpu";
import {
  float,
  fwidth,
  mix,
  normalLocal,
  positionLocal,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { ShaderNodeObject } from "three/tsl";
import type { Node } from "three/webgpu";
import { tslExports } from "vgpu/three";
import lavaModule from "./lava.wgsl";
import {
  sampleDisplacementVolume,
  sampleFieldVolume,
  type LavaFieldVolumes,
} from "./bake-lava.ts";

type LavaMaterialExports = {
  blackbody: { t: Node };
  perlin3: { position: Node };
};

const { blackbody, perlin3 } = tslExports<LavaMaterialExports>(lavaModule)(
  "blackbody",
  "perlin3",
);

export interface LavaMaterialOptions {
  /** Pre-baked field volumes from `bakeLavaVolumes`. */
  readonly volumes: LavaFieldVolumes;
  /** Drives the breathing pulse; defaults to the TSL `time` node. */
  readonly timeNode?: Node;
}

export interface LavaMaterial {
  readonly material: THREE.MeshPhysicalNodeMaterial;
  /** Emissive strength of the molten channels. */
  readonly glowIntensity: ReturnType<typeof uniform<number>>;
  /** Spatial frequency of the lava field on the mesh. */
  readonly scale: ReturnType<typeof uniform<number>>;
}

/**
 * Cooling basalt crust over an incandescent molten interior — same
 * composition as before, split between pre-baked volumes and seamless
 * triplanar detail tiles. Smooth fields (domes, melt, glow, masks) come out
 * of the volumes; the crust's signature fine structure — flaky scabs,
 * seams, vesicle pits, mineral grain — is stored in mipmapped 2D bakes so it
 * remains sharp without evaluating noise per fragment. The breathing pulse
 * stays live (its phase is a baked channel), and the ember seep gates the
 * baked fringe through the same grain that drives the micro normals, so the
 * speckle stays registered with them.
 */
export function createLavaMaterial(options: LavaMaterialOptions): LavaMaterial {
  const { volumes } = options;
  const glowIntensity = uniform(1.6);
  const scale = uniform(1.0);
  // Every caller hands in a TSL-built node (float(...) or the time node);
  // the option keeps the broader Node type for API symmetry with the scene.
  const t = (options.timeNode ?? time) as ShaderNodeObject<Node>;

  const p = positionLocal.mul(scale);

  // Baked registers. Glow: x = sqrt(heat/1.6) sans seep, y = melt mask,
  // z = pulse phase, w = sqrt(seepable fringe/1.4). SurfaceA: x = smooth
  // crust height, y = cooling skin, z = glass mask, w = spec mottle.
  // SurfaceB: x = tone, y = oxide, z = fine crevice, w = iridescence.
  const glow = sampleFieldVolume(volumes.glow, p);
  const surfaceA = sampleFieldVolume(volumes.surfaceA, p);
  const surfaceB = sampleFieldVolume(volumes.surfaceB, p);
  const molten = glow.y;
  const specMottle = surfaceA.w;
  const glass = surfaceA.z;
  const tone = surfaceB.x;
  const oxide = surfaceB.y;
  const crevice = surfaceB.z;
  const irid = surfaceB.w;

  // High-frequency mineral grain is a seamless, mipmapped 2D bake sampled
  // triplanarly. RGB is sampled at the original 19-cycle grain frequency;
  // alpha is sampled separately so the streak register retains its authored
  // 24/7/24 anisotropy. Six filtered taps replace the live four-octave noise
  // plus its three finite-difference evaluations.
  const weightsRaw = normalLocal.abs().pow(8).toVar();
  const weights = weightsRaw.div(weightsRaw.x.add(weightsRaw.y).add(weightsRaw.z));
  const phaseX = vec2(0.17, 0.53);
  const phaseY = vec2(0.61, 0.11);
  const phaseZ = vec2(0.37, 0.79);
  const grainScale = 19 / 48;
  const grainX = texture(volumes.microDetail, p.yz.mul(grainScale).add(phaseX));
  const grainY = texture(volumes.microDetail, p.xz.mul(grainScale).add(phaseY));
  const grainZ = texture(volumes.microDetail, p.xy.mul(grainScale).add(phaseZ));
  const grain = grainX.x.mul(weights.x)
    .add(grainY.x.mul(weights.y))
    .add(grainZ.x.mul(weights.z));

  const streakPeriod = 64;
  const streakX = texture(
    volumes.microDetail,
    p.yz.mul(vec2(7 / streakPeriod, 24 / streakPeriod))
      .add(vec2(8 / streakPeriod, 15 / streakPeriod))
      .add(phaseX)
  ).w;
  const streakY = texture(
    volumes.microDetail,
    p.xz.mul(vec2(24 / streakPeriod, 24 / streakPeriod))
      .add(vec2(4 / streakPeriod, 15 / streakPeriod))
      .add(phaseY)
  ).w;
  const streakZ = texture(
    volumes.microDetail,
    p.xy.mul(vec2(24 / streakPeriod, 7 / streakPeriod))
      .add(vec2(4 / streakPeriod, 8 / streakPeriod))
      .add(phaseZ)
  ).w;
  const streaks = streakX.mul(weights.x)
    .add(streakY.mul(weights.y))
    .add(streakZ.mul(weights.z));

  // GB stores d(grain)/d(tile uv). Apply the coordinate chain rule for the
  // object-space grain coordinates, then blend the projection gradients.
  const microGrad = vec3(0, grainX.y, grainX.z).mul(weights.x)
    .add(vec3(grainY.y, 0, grainY.z).mul(weights.y))
    .add(vec3(grainZ.y, grainZ.z, 0).mul(weights.z))
    .mul(grainScale);
  const microTangent = microGrad.sub(normalLocal.mul(microGrad.dot(normalLocal)));

  // Flaky scabs, seams and vesicle pits come from a second seamless tile over
  // a four-unit object-space period. Three triplanar taps replace the live
  // base field plus three finite-difference calls (nine Voronoi evaluations
  // and a clustered fBm in total), while implicit mips band-limit the detail.
  const sharpTileScale = 1 / 4;
  const sharpX = texture(
    volumes.sharpDetail,
    p.yz.mul(sharpTileScale).add(vec2(0.13, 0.47))
  );
  const sharpY = texture(
    volumes.sharpDetail,
    p.xz.mul(sharpTileScale).add(vec2(0.59, 0.07))
  );
  const sharpZ = texture(
    volumes.sharpDetail,
    p.xy.mul(sharpTileScale).add(vec2(0.31, 0.83))
  );
  const scabs = sharpX.x.mul(weights.x)
    .add(sharpY.x.mul(weights.y))
    .add(sharpZ.x.mul(weights.z));
  const pits = sharpX.w.mul(weights.x)
    .add(sharpY.w.mul(weights.y))
    .add(sharpZ.w.mul(weights.z));
  // Flake seams are capped at 0.55 in A. Values above that threshold can
  // only be vesicle cores, which are the portion that dents height and AO.
  const pitsOnly = smoothstep(0.58, 0.82, pits);
  const sharpGrad = vec3(0, sharpX.y, sharpX.z).mul(weights.x)
    .add(vec3(sharpY.y, 0, sharpY.z).mul(weights.y))
    .add(vec3(sharpZ.y, sharpZ.z, 0).mul(weights.z))
    .mul(sharpTileScale);
  const height = surfaceA.x.add(scabs).sub(pitsOnly.mul(0.08)).clamp(0, 1);

  // Slow breathing so the melt looks alive, and the ember seep gating the
  // baked fringe through the LIVE grain — the same register the micro
  // normals use, so the speckle sits in crevices you can actually see.
  const pulse = t.mul(0.7).add(glow.z.mul(6.2831853)).sin().mul(0.1).add(0.9);
  const seep = smoothstep(0.62, 0.25, grain);
  const fringe = glow.w.mul(glow.w).mul(1.4).mul(seep);
  const heat = glow.x.mul(glow.x).mul(1.6).add(fringe).mul(pulse).clamp(0, 1);
  const incandescence = heat.pow(1.35);

  // Band-limiting: fade each detail register out as its wavelength drops
  // under the pixel footprint, so distant/minified areas stay clean instead
  // of dissolving into per-pixel speckle.
  const footprint = fwidth(p).length();
  const microFade = smoothstep(0.022, 0.007, footprint);
  const striaeFade = smoothstep(0.012, 0.004, footprint);

  const material = new THREE.MeshPhysicalNodeMaterial({ metalness: 0 });

  // Basalt skin: warm dusty grey-brown, ridges catching more light than the
  // fissured low ground, rust staining on older patches, and pits plus
  // flake seams going almost black.
  const ash = mix(vec3(0.045, 0.04, 0.036), vec3(0.19, 0.17, 0.15), tone);
  const ridgeLight = height.mul(height).mul(0.6).add(0.6);
  const stained = mix(ash.mul(ridgeLight), vec3(0.20, 0.085, 0.05), oxide.mul(0.5));
  const basalt = mix(stained, stained.mul(0.4), pits);
  material.colorNode = mix(basalt, vec3(0.012, 0.01, 0.009), molten);

  // Incandescence: blackbody ramp over the baked heat field, crushed
  // slightly so contact rims go yellow-white while striation crests cool
  // through deep red.
  material.emissiveNode = blackbody({ t: incandescence }).mul(glowIntensity);

  // Roughness map, not a constant: rubble is matte with sharp grain breakup,
  // the glassy skin is polished but streaked by flow lines, vesicle pits and
  // dusty valleys scatter more, and molten rock is a glossy liquid.
  const crustRoughness = mix(float(0.94), float(0.55), glass)
    .add(grain.sub(0.5).mul(microFade.mul(0.14)))
    .add(streaks.sub(0.5).mul(0.12).mul(glass))
    .add(pits.mul(0.08))
    .add(height.oneMinus().mul(0.05));
  const moltenRoughness = float(0.32).add(streaks.sub(0.5).mul(0.1));
  material.roughnessNode = mix(crustRoughness, moltenRoughness, molten).clamp(0.05, 1);
  material.clearcoatNode = glass.mul(0.25).mul(molten.oneMinus());
  material.clearcoatRoughnessNode = float(0.22).add(grain.sub(0.5).mul(0.15)).clamp(0.05, 1);

  // PBR refinement from the baked registers; only the facet glints stay
  // live, being a single high-frequency perlin tap.
  const facets = smoothstep(
    0.72,
    0.92,
    perlin3({ position: p.mul(21).add(vec3(11, 3, 29)) })
  );
  // Cavity occlusion, rebuilt from the baked crevice mask plus the live
  // pits — the same formula crustPbr used.
  const cavity = float(1).sub(crevice.mul(0.5)).sub(pitsOnly.mul(0.35)).clamp(0, 1);
  material.aoNode = cavity;
  material.specularIntensityNode = mix(specMottle, float(1), molten);
  material.metalnessNode = facets.mul(glass.mul(0.25).add(0.05)).mul(molten.oneMinus());
  material.iridescenceNode = irid.mul(glass).mul(0.15);
  material.iridescenceIORNode = float(2.0);
  material.iridescenceThicknessNode = irid.mul(250).add(150);

  // Vertex displacement is one small-volume tap: the bake already combined
  // plate bulge minus channel sink into a single encoded scalar.
  const relief = sampleDisplacementVolume(volumes.displacement, p)
    .x.mul(0.9)
    .sub(0.4)
    .mul(0.12);
  material.positionNode = positionLocal.add(normalLocal.mul(relief));

  // Bump normals: the smooth plate/rope gradient finite-differences the
  // baked volume, then combines with the sharp tile's pre-baked derivatives.
  const eps = 0.024;
  const smoothHeight = surfaceA.x;
  const offsetX = sampleFieldVolume(volumes.surfaceA, p.add(vec3(eps, 0, 0)));
  const offsetY = sampleFieldVolume(volumes.surfaceA, p.add(vec3(0, eps, 0)));
  const offsetZ = sampleFieldVolume(volumes.surfaceA, p.add(vec3(0, 0, eps)));
  const grad = vec3(
    offsetX.x.sub(smoothHeight),
    offsetY.x.sub(smoothHeight),
    offsetZ.x.sub(smoothHeight)
  )
    .div(eps)
    .add(sharpGrad);
  const tangentGrad = grad.sub(normalLocal.mul(grad.dot(normalLocal)));

  const skin = surfaceA.y;
  const skinGrad = vec3(
    offsetX.y.sub(skin),
    offsetY.y.sub(skin),
    offsetZ.y.sub(skin)
  ).div(eps);
  const skinTangent = skinGrad.sub(normalLocal.mul(skinGrad.dot(normalLocal)));

  // The broad red fringe is hot rock, even where the narrower liquid mask has
  // not opened yet. Fade the large crust-plate normal against the exact signal
  // that starts blackbody incandescence, so Voronoi slabs are gone by the time
  // the surface reads visibly red instead of embossing a stone normal on lava.
  const hotSurface = smoothstep(0.015, 0.09, incandescence);
  const crustNormalFade = hotSurface.oneMinus();
  const bumped = normalLocal
    .sub(tangentGrad.mul(float(0.16).mul(crustNormalFade)))
    .sub(
      microTangent.mul(
        mix(float(0.022), float(0.008), hotSurface).mul(microFade)
      )
    )
    .sub(skinTangent.mul(molten.mul(0.014).mul(striaeFade)))
    .normalize();
  material.normalNode = transformNormalToView(bumped);

  // The clearcoat is the frozen glass skin draped over the rock: it follows
  // the plates but not the mineral grain, so it gets its own smoother normal.
  const skinNormal = normalLocal
    .sub(tangentGrad.mul(float(0.1).mul(crustNormalFade)))
    .normalize();
  material.clearcoatNormalNode = transformNormalToView(skinNormal);

  return { material, glowIntensity, scale };
}
