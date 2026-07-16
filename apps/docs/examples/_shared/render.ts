import { init, type Gpu, type Target } from 'vgpu';

type UniformSchema = Record<string, string>;
type UniformValues = Record<string, number | readonly number[] | Float32Array>;

export interface FragmentExampleOptions {
  fragment: string;
  uniforms?: UniformSchema;
  values?: (time: number, width: number, height: number) => UniformValues;
}

export interface FragmentFrameOptions {
  readonly target: Target;
  readonly time: number;
}

function fragmentUniforms(options: FragmentExampleOptions, time: number, width: number, height: number) {
  return {
    time,
    resolution: [width, height],
    ...(options.values?.(time, width, height) ?? {}),
  };
}

export function renderFragmentFrame(gpu: Gpu, pass: ReturnType<Gpu['pass']>, options: FragmentExampleOptions, { target, time }: FragmentFrameOptions): void {
  const [width, height] = target.size;
  pass.set({
    uniforms: fragmentUniforms(options, time, width, height),
  });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(pass)));
}

export function renderFragmentThumb(gpu: Gpu, target: Target, options: FragmentExampleOptions, { time }: { readonly time: number }): void {
  const pass = gpu.pass(options.fragment);
  renderFragmentFrame(gpu, pass, options, { target, time });
}

export async function runFragmentExample(canvas: HTMLCanvasElement, options: FragmentExampleOptions): Promise<() => void> {
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const pass = gpu.pass(options.fragment);
  const handle = gpu.frame.loop((frame) => {
    const [width, height] = surface.size;
    pass.set({
      uniforms: fragmentUniforms(options, gpu.time, width, height),
    });
    frame.pass({ target: surface }, (p) => p.draw(pass));
  });

  return () => {
    handle.stop();
    gpu.dispose();
  };
}
