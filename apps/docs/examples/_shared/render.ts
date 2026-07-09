import { fullscreenQuad, material, type WgslUniformType } from '@vgpu/render';
import { pass, renderTargetForCanvas } from '@vgpu/render/passes';
import { createBrowserDevice, preferredCanvasFormat } from '../../lib/browser-device';

const VERTEX_WGSL = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3f,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4f {
  return vec4f(input.position, 1.0);
}
`;

type UniformSchema = Record<string, WgslUniformType>;
type UniformValues = Record<string, number | readonly number[] | Float32Array>;

export interface FragmentExampleOptions {
  fragment: string;
  uniforms?: UniformSchema;
  values?: (time: number, width: number, height: number) => UniformValues;
}

export async function runFragmentExample(canvas: HTMLCanvasElement, options: FragmentExampleOptions): Promise<() => void> {
  const device = await createBrowserDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new Error('Unable to create a WebGPU canvas context.');
  }

  const format = preferredCanvasFormat();
  context.configure({ device: device.gpu, format, alphaMode: 'opaque' });

  const mesh = fullscreenQuad({ device });
  const mat = material({
    device,
    vertex: VERTEX_WGSL,
    fragment: options.fragment,
    vertexLayout: 'position-only',
    uniforms: { time: 'f32', resolution: 'vec2f', ...(options.uniforms ?? {}) },
    targetFormat: format,
    depthFormat: null,
  });
  const target = renderTargetForCanvas(context, { clearColor: [0, 0, 0, 1] });

  let disposed = false;
  let raf = 0;
  const start = performance.now();

  const resize = () => {
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

  const frame = () => {
    if (disposed) return;
    const { width, height } = resize();
    const time = (performance.now() - start) / 1000;
    mat.writeUniforms({
      time,
      resolution: [width, height],
      ...(options.values?.(time, width, height) ?? {}),
    });
    pass({ mesh, material: mat, target });
    raf = requestAnimationFrame(frame);
  };

  frame();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    mat.dispose?.();
    device.destroy();
  };
}
