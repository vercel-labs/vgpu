import {
  clock,
  effect,
  frameLoop,
  init,
  sampler,
  surface,
  target,
  type Gpu,
  type Surface,
  type Target,
} from "vgpu";
import { tgpu, d, std } from "typegpu";

const FIELD_SIZE = 1024;
const FIELD_TEXEL = 1 / FIELD_SIZE;

const Params = d.struct({
  time: d.f32,
  aspect: d.f32,
});

const layout = tgpu.bindGroupLayout({
  params: { uniform: Params },
  sourceTexture: { texture: d.texture2d(d.f32) },
  sdfTexture: { texture: d.texture2d(d.f32) },
  gradientTexture: { texture: d.texture2d(d.f32) },
  fieldSampler: { sampler: "filtering" },
});

function lenSq(a: d.v2f) {
  "use gpu";
  return std.dot(a, a);
}

function circularCapSdf(point: d.v2f, center: d.v2f, radius: number, start: d.v2f, end: d.v2f) {
  "use gpu";
  const edge = end.sub(start);
  const relative = point.sub(start);
  const chordPlane = -(edge.x * relative.y - edge.y * relative.x) / std.length(edge);
  return std.max(std.distance(point, center) - radius, chordPlane);
}

function logoLowerSdf(point: d.v2f) {
  "use gpu";
  // The two marked Bezier spans are represented by their endpoint chords here.
  // Circular SDFs below replace only the curved portions outside those chords.
  const vertices = [
    d.vec2f(70.096, 78.046),
    d.vec2f(47.229, 59.178),
    d.vec2f(27.949, 84.01),
    d.vec2f(26.656, 93.114),
    d.vec2f(45.014, 139.314),
    d.vec2f(54.064, 146.321),
    d.vec2f(114.761, 153.989),
    d.vec2f(104.913, 129.627),
    d.vec2f(95.526, 108.203),
    d.vec2f(86.442, 91.533),
  ];
  const p = point.mul(83).add(83);
  let distanceSquared = lenSq(p.sub(vertices[0]));
  let sign = d.f32(1);

  for (const i of std.range(vertices.length)) {
    const j = (i + vertices.length - 1) % vertices.length;
    const edge = vertices[i].sub(vertices[j]);
    const toPoint = p.sub(vertices[j]);
    const projection = std.dot(toPoint, edge) / std.dot(edge, edge);
    const delta = toPoint.sub(edge.mul(std.saturate(projection)));
    distanceSquared = std.min(distanceSquared, lenSq(delta));
    const crosses =
      (p.y >= vertices[j].y && p.y < vertices[i].y && edge.x * toPoint.y > edge.y * toPoint.x) ||
      (p.y < vertices[j].y && p.y >= vertices[i].y && edge.x * toPoint.y <= edge.y * toPoint.x);

    if (crosses) sign = -sign;
  }

  let distance = sign * std.sqrt(distanceSquared);

  distance = std.min(distance, std.distance(p, d.vec2f(35.258, 89.692)) - 9.258);
  distance = std.min(distance, std.distance(p, d.vec2f(55.475, 135.151)) - 11.259);

  return distance / 83;
}

function logoUpperSdf(point: d.v2f): number {
  "use gpu";
  // Control handles from only the three marked Bezier spans are omitted.
  const vertices = [
    d.vec2f(142.384, 103.831),
    d.vec2f(124.137, 56.566),
    d.vec2f(116.178, 50.647),
    d.vec2f(65.172, 46.678),
    d.vec2f(58.438, 46.151),
    d.vec2f(56.279, 42.541),
    d.vec2f(55.605, 40.725),
    d.vec2f(55.324, 39.693),
    d.vec2f(45.228, 3),
    d.vec2f(38.179, 19.648),
    d.vec2f(41.136, 32.294),
    d.vec2f(57.078, 46.05),
    d.vec2f(71.726, 58.079),
    d.vec2f(92.165, 74.862),
    d.vec2f(105.779, 98.495),
    d.vec2f(109.995, 124.56),
    d.vec2f(114.761, 154),
    d.vec2f(141.54, 112.161),
  ];
  const p = point.mul(83).add(83);
  let distanceSquared = lenSq(p.sub(vertices[0]));
  let sign = d.f32(1);

  for (const i of std.range(vertices.length)) {
    const j = (i + vertices.length - 1) % vertices.length;
    const edge = vertices[i].sub(vertices[j]);
    const toPoint = p.sub(vertices[j]);
    const projection = std.saturate(std.dot(toPoint, edge) / std.dot(edge, edge));
    const delta = toPoint.sub(edge.mul(projection));
    distanceSquared = std.min(distanceSquared, lenSq(delta));
    const crosses =
      (p.y >= vertices[j].y && p.y < vertices[i].y && edge.x * toPoint.y > edge.y * toPoint.x) ||
      (p.y < vertices[j].y && p.y >= vertices[i].y && edge.x * toPoint.y <= edge.y * toPoint.x);
    if (crosses) sign = -sign;
  }
  let distance = sign * std.sqrt(distanceSquared);

  distance = std.min(distance, std.distance(p, d.vec2f(115.459, 59.923)) - 9.305);
  distance = std.min(distance, std.distance(p, d.vec2f(133.703, 107.159)) - 9.297);

  distance = std.min(
    distance,
    circularCapSdf(
      p,
      d.vec2f(48.332, 23.943),
      11.023,
      d.vec2f(38.179, 19.648),
      d.vec2f(41.136, 32.294),
    ) * 0.1,
  );

  return distance / 83;
}

function logoSdf(point: d.v2f): number {
  "use gpu";
  return std.min(logoLowerSdf(point), logoUpperSdf(point));
};

function hash(point: d.v2f): number {
  "use gpu";
  return std.fract(std.sin(std.dot(point, d.vec2f(127.1, 311.7))) * 43758.5453);
};

const sdfBakeFragment = tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
  "use gpu";
  const point = input.uv.mul(2).sub(1);
  return d.vec4f(logoSdf(point.mul(1.2)), 0, 0, 1);
});

const gradientFragment = tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
  "use gpu";
  const sample = std.textureSampleLevel(layout.$.sourceTexture, layout.$.fieldSampler, input.uv, 0).x;
  const derivative = d.vec2f(std.dpdx(sample), std.dpdy(sample));
  const magnitude = std.length(derivative);
  const normal = derivative.div(std.max(magnitude, 0.000001));
  return d.vec4f(normal.mul(0.5).add(0.5), magnitude, 1);
});

const createBlurFragment = (direction: d.v2f) =>
  tgpu.fragmentFn({
    in: { uv: d.vec2f },
    out: d.vec4f,
  })((input) => {
    "use gpu";
    const offset = direction.mul(FIELD_TEXEL);
    let value = std
      .textureSampleLevel(layout.$.sourceTexture, layout.$.fieldSampler, input.uv, 0)
      .mul(0.227027);
    value = value.add(
      std
        .textureSampleLevel(
          layout.$.sourceTexture,
          layout.$.fieldSampler,
          input.uv.add(offset.mul(1.384615)),
          0,
        )
        .mul(0.316216),
    );
    value = value.add(
      std
        .textureSampleLevel(
          layout.$.sourceTexture,
          layout.$.fieldSampler,
          input.uv.sub(offset.mul(1.384615)),
          0,
        )
        .mul(0.316216),
    );
    value = value.add(
      std
        .textureSampleLevel(
          layout.$.sourceTexture,
          layout.$.fieldSampler,
          input.uv.add(offset.mul(3.230769)),
          0,
        )
        .mul(0.07027),
    );
    value = value.add(
      std
        .textureSampleLevel(
          layout.$.sourceTexture,
          layout.$.fieldSampler,
          input.uv.sub(offset.mul(3.230769)),
          0,
        )
        .mul(0.07027),
    );
    return value;
  });

const horizontalBlurFragment = createBlurFragment(d.vec2f(1, 0));
const verticalBlurFragment = createBlurFragment(d.vec2f(0, 1));

const lightStreams = tgpu.fn(
  [d.vec2f, d.f32],
  d.vec3f,
)((point, seconds) => {
  "use gpu";
  const direction = std.normalize(d.vec2f(0.7071 + std.sin(seconds) * 5, -0.7071));
  const normal = d.vec2f(0.7071, 0.7071);
  const along = std.dot(point, direction);
  const across = std.dot(point, normal);
  const convergence = std.smoothstep(-0.55, 0.38, along);
  const pulse = 0.76 + 0.24 * std.sin(seconds * 2.2 - along * 7.5);
  const shimmer = 0.82 + 0.18 * std.sin(seconds * 4.1 + along * 14 + across * 5);
  let color = d.vec3f(0);

  const split = 0.15;

  const redCenter = -split * (1 - convergence) + 0.01 * std.sin(along * 8 - seconds * 1.7);
  const greenCenter = 0.01 * std.sin(along * 9 + seconds * 1.3);
  const blueCenter = split * (1 - convergence) + 0.01 * std.sin(along * 7 + seconds * 1.9);
  const width = std.mix(0.045, 0.075, convergence);
  const red = std.exp(-std.pow(std.abs(across - redCenter) / width, 1.65));
  const green = std.exp(-std.pow(std.abs(across - greenCenter) / width, 1.65));
  const blue = std.exp(-std.pow(std.abs(across - blueCenter) / width, 1.65));

  const redc = d.vec3f(1, 0, 0.2).mul(red);
  const greenc = d.vec3f(0, 0.2, 0.3).mul(green);
  const bluec = d.vec3f(0.2, 0.1, 1).mul(blue);

  color = color.add((redc.add(greenc).add(bluec)).mul(pulse).mul(shimmer));

  const mergedWidth = 0.06 + 0.035 * convergence;
  const merged = std.exp(-std.pow(std.abs(across) / mergedWidth, 1.45)) * convergence;
  color = color.add(
    d
      .vec3f(1, 0.94, 0.88)
      .mul(merged)
      .mul(1.15 + 0.35 * std.sin(seconds * 2.7 - along * 9)),
  );
  const halo = std.exp(-std.abs(across) * 7.5) * (0.16 + 0.22 * convergence);
  return color.add(d.vec3f(0.34, 0.2, 0.62).mul(halo));
});

const fragmentFn = tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
  "use gpu";
  const seconds = layout.$.params.time;
  const p = input.uv.sub(0.5).mul(2).mul(d.vec2f(layout.$.params.aspect, 1));
  const fieldUv = p.div(0.72).mul(0.5).add(0.5);
  const distance =
    std.textureSampleLevel(layout.$.sdfTexture, layout.$.fieldSampler, fieldUv, 0).x * 0.72;
  const smoothedDerivative = std.textureSampleLevel(
    layout.$.gradientTexture,
    layout.$.fieldSampler,
    fieldUv,
    0,
  );
  const pixelWidth = std.fwidth(distance);
  const logoMask = std.smoothstep(pixelWidth, -pixelWidth, distance);

  const decodedGradient = smoothedDerivative.rg.mul(2).sub(1);
  const glassNormal = decodedGradient.div(std.max(std.length(decodedGradient), 0.0001));
  const ripple = std.sin(p.y * 16 - seconds * 2.5) * std.sin(p.x * 11 + seconds * 1.8);
  const warpedPoint = p.add(glassNormal.mul(0.055 + ripple * 0.014).mul(logoMask));

  const streams = lightStreams(p, seconds);
  const refracted = lightStreams(warpedPoint.mul(1.06).sub(d.vec2f(0.025, -0.015)), seconds + 0.18);
  const grain = hash(std.floor(input.uv.mul(520)).add(std.floor(seconds * 3))) - 0.5;
  const vignette = 1 - 0.38 * std.smoothstep(0.35, 1.45, std.length(p));
  let color = d.vec3f(0.014, 0.009, 0.03);
  color = color.add(streams.mul(0.2));
  color = std.mix(color, refracted.mul(1.08).add(color.mul(0.25)), logoMask);

  const innerGlow = std.exp(-std.abs(distance) * 24) * logoMask;
  const rim = std.exp(-std.abs(distance) * 95);
  const specular = std.pow(std.max(std.dot(glassNormal, d.vec2f(-0.62, -0.78)), 0), 9) * rim;
  const shadow = std.smoothstep(0.09, 0, distance) * (1 - logoMask);
  color = color.mul(1 - shadow * 0.42);
  color = color.add(d.vec3f(0.17, 0.3, 0.56).mul(innerGlow).mul(0.22));
  color = color.add(d.vec3f(0.72, 0.9, 1).mul(rim).mul(0.32));
  color = color.add(d.vec3f(1, 0.96, 0.9).mul(specular).mul(1.2));
  color = color.add(grain * 0.018);
  color = color.mul(vignette);
  color = d.vec3f(1).sub(std.exp(color.mul(-1.35))); // tonemapping

  return d.vec4f(color, 1);
});

type Output = Surface | Target;

export function createLiquidGlassScene(gpu: Gpu, output: Output) {
  const sdfBakeSource = tgpu.resolve([sdfBakeFragment]);
  const gradientSource = tgpu.resolve([gradientFragment]);
  const horizontalBlurSource = tgpu.resolve([horizontalBlurFragment]);
  const verticalBlurSource = tgpu.resolve([verticalBlurFragment]);
  const shaderSource = tgpu.resolve([fragmentFn]);

  let sdfField: Target | undefined;
  let rawGradient: Target | undefined;
  let blurA: Target | undefined;
  let blurB: Target | undefined;
  try {
    sdfField = target(gpu, {
      size: [FIELD_SIZE, FIELD_SIZE],
      format: "rgba16float",
      label: "typegpu-sdf-field",
    });
    rawGradient = target(gpu, {
      size: [FIELD_SIZE, FIELD_SIZE],
      format: "rgba16float",
      label: "typegpu-sdf-gradient",
    });
    blurA = target(gpu, {
      size: [FIELD_SIZE, FIELD_SIZE],
      format: "rgba16float",
      label: "typegpu-sdf-blur-a",
    });
    blurB = target(gpu, {
      size: [FIELD_SIZE, FIELD_SIZE],
      format: "rgba16float",
      label: "typegpu-sdf-blur-b",
    });

    const linearSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const sdfBake = effect(gpu, sdfBakeSource, { label: "typegpu-sdf-bake" });
    const extractGradient = effect(gpu, gradientSource, {
      label: "typegpu-sdf-gradient",
      set: { sourceTexture: sdfField, fieldSampler: linearSampler },
    });
    const blurPasses = 16;
    const blurEffects = Array.from({ length: blurPasses }, (_, i) => {
      return {
        horizontal: effect(gpu, horizontalBlurSource, {
          label: `typegpu-sdf-blur-horizontal-${i}`,
          set: {
            sourceTexture: i === 0 ? rawGradient : blurB,
            fieldSampler: linearSampler,
          },
        }),
        vertical: effect(gpu, verticalBlurSource, {
          label: `typegpu-sdf-blur-vertical-${i}`,
          set: { sourceTexture: blurA, fieldSampler: linearSampler },
        }),
      };
    });

    sdfBake.draw(sdfField);
    extractGradient.draw(rawGradient);
    for (const effect of blurEffects) {
      effect.horizontal.draw(blurA);
      effect.vertical.draw(blurB);
    }

    const shader = effect(gpu, shaderSource, {
      label: "typegpu-liquid-glass",
      set: {
        params: { time: 0, aspect: 1 },
        sdfTexture: sdfField,
        gradientTexture: blurB,
        fieldSampler: linearSampler,
      },
    });
    const setParams = (seconds: number) =>
      shader.set({
        params: { time: seconds, aspect: output.size[0] / output.size[1] },
      });
    setParams(0);

    return {
      shader,
      setParams,
      dispose: () => [blurB, blurA, rawGradient, sdfField].forEach(destroyTarget),
    };
  } catch (error) {
    [blurB, blurA, rawGradient, sdfField].forEach(destroyTarget);
    throw error;
  }
}

function destroyTarget(value: Target | undefined): void {
  (value as { destroy?: () => void } | undefined)?.destroy?.();
}

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let unsubscribeResize: (() => void) | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeResize?.();
    gpu?.dispose();
  };

  const ready = (async () => {
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    try {
      const output = surface(gpu, canvas, { dpr: [1, 2] });
      const timeline = clock(gpu);
      const scene = createLiquidGlassScene(gpu, output);
      unsubscribeResize = output.onResize(() => scene.setParams(timeline.time));

      frameLoop(gpu, (currentFrame) => {
        scene.setParams(timeline.time);
        currentFrame.pass(output, scene.shader);
      });
    } catch (error) {
      dispose();
      throw error;
    }
  })();

  return { ready, dispose };
}
