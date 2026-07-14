import { init } from 'vgpu';

type UniformSchema = Record<string, string>;
type UniformValues = Record<string, number | readonly number[] | Float32Array>;

export interface FragmentExampleOptions {
  fragment: string;
  uniforms?: UniformSchema;
  values?: (time: number, width: number, height: number) => UniformValues;
}

export async function runFragmentExample(canvas: HTMLCanvasElement, options: FragmentExampleOptions): Promise<() => void> {
  const gpu = await init(canvas, { dpr: [1, 2], autoResize: true });
  const pass = gpu.pass(options.fragment);
  const handle = gpu.frame.loop(() => {
    const [width, height] = gpu.screen?.size ?? [canvas.width, canvas.height];
    pass.set({
      uniforms: {
        time: gpu.time,
        resolution: [width, height],
        ...(options.values?.(gpu.time, width, height) ?? {}),
      },
    });
    pass.draw();
  });

  return () => {
    handle.stop();
    gpu.dispose();
  };
}
