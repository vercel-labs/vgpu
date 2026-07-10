import { createBrowserDevice, preferredCanvasFormat } from '../../lib/browser-device';
import computeSource from './compute.wgsl';
import renderSource from './render.wgsl';

const PARTICLE_COUNT = 24000;
const TRIANGLE_RADIUS = 1.45;

type Point = readonly [number, number];

function randomPointOnTriangleEdge(radius: number): Point {
  const edge = Math.floor(Math.random() * 3);
  const t = Math.random();
  const k = Math.sqrt(3);
  const vertices: Point[] = [
    [0, (2 * radius) / k],
    [-radius, -radius / k],
    [radius, -radius / k],
  ];
  const a = vertices[edge];
  const b = vertices[(edge + 1) % 3];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const device = await createBrowserDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new Error('Unable to create a WebGPU canvas context.');
  }

  const format = preferredCanvasFormat();
  context.configure({ device: device.gpu, format, alphaMode: 'opaque' });

  const positions = new Float32Array(PARTICLE_COUNT * 4);
  const velocities = new Float32Array(PARTICLE_COUNT * 4);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const [x, y] = randomPointOnTriangleEdge(TRIANGLE_RADIUS);
    const px = x + (Math.random() - 0.5) * 0.035;
    const py = y + (Math.random() - 0.5) * 0.035;
    positions[i * 4] = px;
    positions[i * 4 + 1] = py - 0.18;
    positions[i * 4 + 2] = px;
    positions[i * 4 + 3] = py - 0.18;
    velocities[i * 4] = (Math.random() - 0.5) * 0.25;
    velocities[i * 4 + 1] = (Math.random() - 0.5) * 0.25;
    velocities[i * 4 + 2] = Math.random() * 8;
    velocities[i * 4 + 3] = i + Math.random();
  }

  const positionBuffer = device.createBuffer({ label: 'triangleParticles.positions', size: positions.byteLength, usage: ['storage', 'copy_dst'] });
  const velocityBuffer = device.createBuffer({ label: 'triangleParticles.velocities', size: velocities.byteLength, usage: ['storage', 'copy_dst'] });
  const computeUniformBuffer = device.createBuffer({ label: 'triangleParticles.computeUniforms', size: 32, usage: ['uniform', 'copy_dst'] });
  const renderUniformBuffer = device.createBuffer({ label: 'triangleParticles.renderUniforms', size: 16, usage: ['uniform', 'copy_dst'] });
  positionBuffer.write(positions);
  velocityBuffer.write(velocities);

  const computeModule = device.gpu.createShaderModule({ label: 'triangleParticles.compute', code: computeSource });
  const renderModule = device.gpu.createShaderModule({ label: 'triangleParticles.render', code: renderSource });

  const computeLayout = device.gpu.createBindGroupLayout({
    label: 'triangleParticles.compute.layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const renderLayout = device.gpu.createBindGroupLayout({
    label: 'triangleParticles.render.layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });

  const computePipeline = device.gpu.createComputePipeline({
    label: 'triangleParticles.compute.pipeline',
    layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
    compute: { module: computeModule, entryPoint: 'cs_main' },
  });
  const renderPipeline = device.gpu.createRenderPipeline({
    label: 'triangleParticles.render.pipeline',
    layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [renderLayout] }),
    vertex: { module: renderModule, entryPoint: 'vs_main' },
    fragment: {
      module: renderModule,
      entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const computeBindGroup = device.gpu.createBindGroup({
    label: 'triangleParticles.compute.bindGroup',
    layout: computeLayout,
    entries: [
      { binding: 0, resource: { buffer: computeUniformBuffer.gpu } },
      { binding: 1, resource: { buffer: positionBuffer.gpu } },
      { binding: 2, resource: { buffer: velocityBuffer.gpu } },
    ],
  });
  const renderBindGroup = device.gpu.createBindGroup({
    label: 'triangleParticles.render.bindGroup',
    layout: renderLayout,
    entries: [
      { binding: 0, resource: { buffer: renderUniformBuffer.gpu } },
      { binding: 1, resource: { buffer: positionBuffer.gpu } },
      { binding: 2, resource: { buffer: velocityBuffer.gpu } },
    ],
  });

  let mouse: Point = [0, 0];
  let mouseStrength = 0;
  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const aspect = rect.width / Math.max(rect.height, 1);
    mouse = [x * aspect, y];
    mouseStrength = 2.0;
  };
  canvas.addEventListener('pointermove', onPointerMove);

  const resizeCanvas = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height };
  };

  let disposed = false;
  let raf = 0;
  let last = performance.now();
  const start = last;
  const computeUniforms = new Float32Array(8);
  const renderUniforms = new Float32Array(4);

  const frame = () => {
    if (disposed) return;
    const { width, height } = resizeCanvas();
    const now = performance.now();
    const time = (now - start) / 1000;
    const dt = Math.min(0.033, (now - last) / 1000 || 0.016);
    last = now;
    const aspect = width / Math.max(height, 1);

    computeUniforms.set([time, dt, aspect, PARTICLE_COUNT, mouse[0], mouse[1], mouseStrength, 0]);
    renderUniforms.set([width, height, time, PARTICLE_COUNT]);
    computeUniformBuffer.write(computeUniforms);
    renderUniformBuffer.write(renderUniforms);
    mouseStrength *= 0.92;

    const encoder = device.gpu.createCommandEncoder({ label: 'triangleParticles.frame' });
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
    computePass.end();

    const view = context.getCurrentTexture().createView();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0.005, g: 0.006, b: 0.012, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);
    renderPass.draw(PARTICLE_COUNT * 3);
    renderPass.end();
    device.queue.gpu.submit([encoder.finish()]);

    raf = requestAnimationFrame(frame);
  };

  frame();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointermove', onPointerMove);
    positionBuffer.destroy();
    velocityBuffer.destroy();
    computeUniformBuffer.destroy();
    renderUniformBuffer.destroy();
    device.destroy();
  };
}
