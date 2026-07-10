import { fullscreenQuad, material } from '@vgpu/render';
import { pass, renderTargetForCanvas } from '@vgpu/render/passes';
import { createBrowserDevice, preferredCanvasFormat } from '../../lib/browser-device';
import computeSource from './compute.wgsl';
import displaySource from './display.wgsl';

const VERTEX_WGSL = /* wgsl */ `
struct VertexInput { @location(0) position: vec3f };
@vertex fn vs_main(input: VertexInput) -> @builtin(position) vec4f {
  return vec4f(input.position, 1.0);
}
`;

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const device = await createBrowserDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new Error('Unable to create a WebGPU canvas context.');
  }

  const format = preferredCanvasFormat();
  context.configure({ device: device.gpu, format, alphaMode: 'opaque' });

  const simulationSize = 320;
  const dyeTexture = device.createTexture({
    label: 'fluid.dye',
    size: [simulationSize, simulationSize],
    format: 'rgba8unorm',
    usage: ['storage_binding', 'texture_binding', 'copy_src'],
  });

  const uniformBuffer = device.createBuffer({
    label: 'fluid.uniforms',
    size: 16,
    usage: ['uniform', 'copy_dst'],
  });

  const computeModule = device.gpu.createShaderModule({ label: 'fluid.compute', code: computeSource });
  const computeLayout = device.gpu.createBindGroupLayout({
    label: 'fluid.compute.layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
    ],
  });
  const computePipeline = device.gpu.createComputePipeline({
    label: 'fluid.compute.pipeline',
    layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
    compute: { module: computeModule, entryPoint: 'cs_main' },
  });
  const computeBindGroup = device.gpu.createBindGroup({
    label: 'fluid.compute.bindGroup',
    layout: computeLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer.gpu } },
      { binding: 1, resource: dyeTexture.createView() },
    ],
  });

  const mesh = fullscreenQuad({ device });
  const display = material({
    device,
    vertex: VERTEX_WGSL,
    fragment: displaySource,
    vertexLayout: 'position-only',
    uniforms: { resolution: 'vec2f' },
    textures: { dyeTexture: 'texture_2d_f32' },
    autoDeclarations: true,
    targetFormat: format,
    depthFormat: null,
  });
  display.writeTextures({ dyeTexture });
  const target = renderTargetForCanvas(context, { clearColor: [0, 0, 0, 1] });

  let disposed = false;
  let raf = 0;
  let frameIndex = 0;
  const start = performance.now();

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

  const uniforms = new Float32Array(4);
  const frame = () => {
    if (disposed) return;
    const { width, height } = resizeCanvas();
    const time = (performance.now() - start) / 1000;
    uniforms[0] = width;
    uniforms[1] = height;
    uniforms[2] = time;
    uniforms[3] = frameIndex++;
    uniformBuffer.write(uniforms);

    const encoder = device.gpu.createCommandEncoder({ label: 'fluid.frame' });
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(Math.ceil(simulationSize / 8), Math.ceil(simulationSize / 8));
    computePass.end();
    device.queue.gpu.submit([encoder.finish()]);

    display.writeUniforms({ resolution: [width, height] });
    pass({ mesh, material: display, target });
    raf = requestAnimationFrame(frame);
  };

  frame();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    display.dispose?.();
    uniformBuffer.destroy();
    dyeTexture.destroy();
    device.destroy();
  };
}
