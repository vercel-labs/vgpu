import type { Device, Texture } from 'vgpu';
import { type SceneTunables } from './light-sources-pass';
import { createDrawBundle } from '../pipeline-utils';
import {
  canonicalTriangleGeometry,
  GOD_RAY_DEFAULTS,
  LIGHT_AO_DEFAULTS,
  PROBE_DISCARD_DEFAULTS,
  type CascadeFitRect,
  type GodRaySettings,
  type LightAoSettings,
  type ProbeDiscardSettings,
  type RenderSize,
} from '../settings';

export const MAIN_SCENE_FORMAT: GPUTextureFormat = 'rgba16float';

export interface MainSceneShared {
  floorPipeline: GPURenderPipeline;
  floorBindGroupLayout: GPUBindGroupLayout;
  trianglePipeline: GPURenderPipeline;
  triangleBindGroupLayout: GPUBindGroupLayout;
  godRayPipeline: GPURenderPipeline;
  godRayBindGroupLayout: GPUBindGroupLayout;
  floorNoisePipeline: GPURenderPipeline;
  linearSampler: GPUSampler;
}

export interface MainScenePass {
  texture: Texture;
  view: GPUTextureView;
  encode(encoder: GPUCommandEncoder, inputs: MainSceneInputs): void;
  destroy(): void;
}

export interface MainSceneInputs {
  width: number;
  height: number;
  tunables: SceneTunables;
  probeDiscard?: ProbeDiscardSettings;
  theme?: 'dark' | 'light';
  lightAo?: LightAoSettings;
  godRays?: GodRaySettings;
}

export function createMainScenePass(
  device: Device,
  shared: MainSceneShared,
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  cascadeFit: CascadeFitRect,
  radianceView: GPUTextureView,
  lightSourcesView: GPUTextureView,
): MainScenePass {
  const texture = device.createTexture({
    size: [presentationSize.width, presentationSize.height],
    format: MAIN_SCENE_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label: 'triangle-led-4-main-scene',
  });
  const view = texture.createView();
  const floorNoise = createFloorNoiseTexture(device, shared.floorNoisePipeline);
  const floorNoiseView = floorNoise.createView();

  const floorUniform = device.createBuffer({
    size: 96,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-main-scene-floor-uniform',
  });
  const floorBindGroup = device.gpu.createBindGroup({
    layout: shared.floorBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: floorUniform.gpu } },
      { binding: 1, resource: radianceView },
      { binding: 2, resource: lightSourcesView },
      { binding: 3, resource: shared.linearSampler },
      { binding: 4, resource: floorNoiseView },
    ],
  });
  const triangleUniform = device.createBuffer({
    size: 16,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-main-scene-triangle-uniform',
  });
  triangleUniform.write(triangleCamera(presentationSize, 'dark'));
  const triangleVertices = device.createBuffer({
    size: 36,
    usage: ['vertex', 'copy_dst'],
    label: 'triangle-led-4-main-scene-triangle-vertices',
  });
  triangleVertices.write(triangleVertexData(simulationSize, presentationSize));
  const triangleBindGroup = device.gpu.createBindGroup({
    layout: shared.triangleBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: triangleUniform.gpu } }],
  });
  const godRayUniform = device.createBuffer({
    size: 64,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-god-rays-main-scene-uniform',
  });
  const godRayVertices = device.createBuffer({
    size: 18 * 8 * 4,
    usage: ['vertex', 'copy_dst'],
    label: 'triangle-led-god-rays-main-scene-vertices',
  });
  const godRayBindGroup = device.gpu.createBindGroup({
    layout: shared.godRayBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: godRayUniform.gpu } },
      { binding: 1, resource: radianceView },
      { binding: 2, resource: shared.linearSampler },
    ],
  });
  const bundle = createDrawBundle(
    device,
    'triangle-led-4-main-scene-with-triangle-bundle',
    MAIN_SCENE_FORMAT,
    (pass) => {
      pass.setPipeline(shared.floorPipeline);
      pass.setBindGroup(0, floorBindGroup);
      pass.draw(3);
      pass.setPipeline(shared.trianglePipeline);
      pass.setBindGroup(0, triangleBindGroup);
      pass.setVertexBuffer(0, triangleVertices.gpu);
      pass.draw(3);
      pass.setPipeline(shared.godRayPipeline);
      pass.setBindGroup(0, godRayBindGroup);
      pass.setVertexBuffer(0, godRayVertices.gpu);
      pass.draw(18);
    },
  );

  return {
    texture,
    view,
    encode(
      encoder,
      {
        width,
        height,
        tunables,
        probeDiscard = PROBE_DISCARD_DEFAULTS,
        theme = 'dark',
        lightAo = LIGHT_AO_DEFAULTS,
        godRays = GOD_RAY_DEFAULTS,
      },
    ) {
      floorUniform.write(
        floorUniformData(
          width,
          height,
          simulationSize,
          presentationSize,
          cascadeFit,
          tunables,
          probeDiscard,
          theme,
          lightAo,
        ),
      );
      triangleUniform.write(triangleCamera(presentationSize, theme));
      godRayUniform.write(
        godRayUniformData(simulationSize, presentationSize, cascadeFit, godRays, theme),
      );
      godRayVertices.write(
        godRayVertexData(simulationSize, presentationSize, godRays),
      );
      const pass = encoder.beginRenderPass({
        label: 'triangle-led-4-main-scene',
        colorAttachments: [
          { view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      });
      pass.executeBundles([bundle]);
      pass.end();
    },
    destroy() {
      texture.gpu.destroy();
      floorNoise.gpu.destroy();
      floorUniform.gpu.destroy();
      triangleUniform.gpu.destroy();
      triangleVertices.gpu.destroy();
      godRayUniform.gpu.destroy();
      godRayVertices.gpu.destroy();
    },
  };
}

function createFloorNoiseTexture(device: Device, pipeline: GPURenderPipeline) {
  const noiseSize = 500;
  const texture = device.createTexture({
    size: [noiseSize, noiseSize],
    format: 'rgba8unorm',
    usage: ['render_attachment', 'texture_binding'],
    label: 'triangle-led-4-floor-noise',
  });
  const encoder = device.gpu.createCommandEncoder({
    label: 'triangle-led-4-floor-noise',
  });
  const pass = encoder.beginRenderPass({
    label: 'triangle-led-4-floor-noise',
    colorAttachments: [
      {
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0, 0, 0, 1],
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.gpu.submit([encoder.finish()]);
  return texture;
}

function floorUniformData(
  width: number,
  height: number,
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  cascadeFit: CascadeFitRect,
  tunables: SceneTunables,
  probeDiscard: ProbeDiscardSettings,
  theme: 'dark' | 'light',
  lightAo: LightAoSettings,
) {
  const out = new Float32Array(24);
  const triangle = presentationTriangleParams(simulationSize, presentationSize);
  const isLightTheme = theme === 'light' ? 1 : 0;
  const aoStrength = theme === 'light' ? lightAo.opacity : 0;
  const aoSize = theme === 'light' ? lightAo.size : 0;
  out.set([width, height, isLightTheme, aoStrength], 0);
  out.set([simulationSize.width, simulationSize.height, 0, 0], 4);
  out.set([tunables.ledIntensity, tunables.floorAlbedo, 0, 0], 8);
  out.set(
    [
      triangle.centerX,
      triangle.centerY,
      triangle.circumradiusY,
      triangle.halfSideX,
    ],
    12,
  );
  out.set(
    [
      probeDiscard.lightAabbPadding * triangle.scaleX,
      probeDiscard.lightAabbPadding * triangle.scaleY,
      probeDiscard.probeDiscardDistance,
      aoSize,
    ],
    16,
  );
  out.set(
    [
      cascadeFit.originSceneX * triangle.scaleX,
      cascadeFit.originSceneY * triangle.scaleY,
      cascadeFit.widthScene * triangle.scaleX,
      cascadeFit.heightScene * triangle.scaleY,
    ],
    20,
  );
  return out;
}

function triangleCamera(size: RenderSize, theme: 'dark' | 'light') {
  return new Float32Array([
    size.width / size.height,
    theme === 'light' ? 1 : 0,
    0,
    0,
  ]);
}

function triangleVertexData(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
) {
  const triangle = presentationTriangleVertices(
    simulationSize,
    presentationSize,
  );
  const aspect = presentationSize.width / presentationSize.height;
  const toVertex = (p: { x: number; y: number }) => {
    const clipX = (p.x / presentationSize.width) * 2 - 1;
    const clipY = 1 - (p.y / presentationSize.height) * 2;
    return [clipX * aspect, 0, -clipY] as const;
  };
  return new Float32Array([
    ...toVertex(triangle.top),
    ...toVertex(triangle.left),
    ...toVertex(triangle.right),
  ]);
}

function godRayUniformData(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  cascadeFit: CascadeFitRect,
  settings: GodRaySettings,
  theme: 'dark' | 'light',
) {
  const out = new Float32Array(16);
  const scaleX = presentationSize.width / simulationSize.width;
  const scaleY = presentationSize.height / simulationSize.height;
  out.set([
    presentationSize.width,
    presentationSize.height,
    presentationSize.width / presentationSize.height,
    theme === 'light' ? 1 : 0,
  ], 0);
  out.set([
    cascadeFit.originSceneX * scaleX,
    cascadeFit.originSceneY * scaleY,
    cascadeFit.widthScene * scaleX,
    cascadeFit.heightScene * scaleY,
  ], 4);
  out.set([
    settings.enabled ? 1 : 0,
    settings.opacity,
    settings.contrastLo,
    settings.contrastHi,
  ], 8);
  out.set([settings.feather, settings.intensity, settings.stretch, settings.contrastPower], 12);
  return out;
}

function godRayVertexData(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  settings: GodRaySettings,
) {
  const triangle = presentationTriangleVertices(simulationSize, presentationSize);
  const center = presentationTriangleParams(simulationSize, presentationSize);
  const aspect = presentationSize.width / presentationSize.height;
  const c = { x: center.centerX, y: center.centerY };
  const scalePoint = (p: { x: number; y: number }, scale: number) => ({
    x: c.x + (p.x - c.x) * (1 + scale),
    y: c.y + (p.y - c.y) * (1 + scale),
  });
  const toPosition = (p: { x: number; y: number }) => {
    const clipX = (p.x / presentationSize.width) * 2 - 1;
    const clipY = 1 - (p.y / presentationSize.height) * 2;
    return [clipX * aspect, 0, -clipY] as const;
  };
  const vertices: number[] = [];
  const push = (
    position: { x: number; y: number },
    nearSample: { x: number; y: number },
    projectedSample: { x: number; y: number },
    offsetScale: number,
  ) => {
    vertices.push(
      ...toPosition(position),
      nearSample.x,
      nearSample.y,
      projectedSample.x,
      projectedSample.y,
      offsetScale,
    );
  };
  const addQuad = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const aFar = scalePoint(a, settings.scale);
    const bFar = scalePoint(b, settings.scale);
    push(a, a, a, 0);
    push(b, b, b, 0);
    push(bFar, b, bFar, 1);
    push(a, a, a, 0);
    push(bFar, b, bFar, 1);
    push(aFar, a, aFar, 1);
  };
  addQuad(triangle.top, triangle.left);
  addQuad(triangle.left, triangle.right);
  addQuad(triangle.right, triangle.top);
  return new Float32Array(vertices);
}

function presentationTriangleParams(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
) {
  const geometry = canonicalTriangleGeometry(simulationSize);
  const scaleX = presentationSize.width / simulationSize.width;
  const scaleY = presentationSize.height / simulationSize.height;
  return {
    centerX: geometry.center.x * scaleX,
    centerY: geometry.center.y * scaleY,
    circumradiusY: geometry.circumradius * scaleY,
    halfSideX: geometry.sideLength * 0.5 * scaleX,
    scaleX,
    scaleY,
  };
}

function presentationTriangleVertices(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
) {
  const geometry = canonicalTriangleGeometry(simulationSize);
  const scaleX = presentationSize.width / simulationSize.width;
  const scaleY = presentationSize.height / simulationSize.height;
  return {
    top: { x: geometry.top.x * scaleX, y: geometry.top.y * scaleY },
    left: { x: geometry.left.x * scaleX, y: geometry.left.y * scaleY },
    right: { x: geometry.right.x * scaleX, y: geometry.right.y * scaleY },
  };
}
