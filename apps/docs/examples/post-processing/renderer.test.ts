import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
const mocks=vi.hoisted(()=>({init:vi.fn()}));vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));
import { Controls } from './controls'; import { DEFAULT_POST_PROCESSING_CONTROLS } from './types'; import { createRenderer, renderThumbnail } from './renderer';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
test('uses shared all-on defaults in accessible controlled toggles',()=>{const html=renderToStaticMarkup(createElement(Controls, { value: DEFAULT_POST_PROCESSING_CONTROLS, onChange: () => {} }));expect(DEFAULT_POST_PROCESSING_CONTROLS).toEqual({bloom:true,ca:true});expect(html).toContain('Post-processing effects');expect(html.match(/checked=""/g)).toHaveLength(2);expect(html).toContain('Chromatic Aberration');});


test('rejects the original init error, reports once, and tears down even when onError throws',async()=>{vi.stubGlobal('window',{devicePixelRatio:1,addEventListener:vi.fn(),removeEventListener:vi.fn()});const failure=new Error('init failed');mocks.init.mockRejectedValueOnce(failure);const onError=vi.fn(()=>{throw new Error('callback failed');});const renderer=createRenderer({canvas:{} as HTMLCanvasElement,onError});await expect(renderer.ready).rejects.toBe(failure);expect(onError).toHaveBeenCalledOnce();renderer.setControls?.({bloom:false,ca:false});expect(onError).toHaveBeenCalledOnce();});


test('cancellation fulfills silently without reporting an error',async()=>{vi.stubGlobal('window',{devicePixelRatio:1,addEventListener:vi.fn(),removeEventListener:vi.fn()});const onError=vi.fn();const renderer=createRenderer({canvas:{} as HTMLCanvasElement,onError});renderer.dispose();await expect(renderer.ready).resolves.toBeUndefined();expect(onError).not.toHaveBeenCalled();});

test('thumbnail compilation failure waits for submitted work and releases owned resources',async()=>{const failure=new Error('compile failed'),destroyBuffer=vi.fn(),settled=vi.fn(async()=>{}),submitted=vi.fn(async()=>{}),destroyTargets=[vi.fn(),vi.fn(),vi.fn(),vi.fn()];let targetIndex=0;const gpu={device:{createBuffer:()=>({gpu:{destroy:destroyBuffer},write:vi.fn()})},gpu:{queue:{onSubmittedWorkDone:submitted}},settled, fns: {draw:()=>({set:vi.fn(),compile:vi.fn(async()=>{throw failure})}),effect:()=>({set:vi.fn(),compile:vi.fn(async()=>{})}),sampler:()=>({}),target:()=>({size:[64,64],format:'rgba8unorm',destroy:destroyTargets[targetIndex++]}) }} as never;const output={size:[64,64],format:'rgba8unorm'} as never;await expect(renderThumbnail(gpu,output)).rejects.toBe(failure);expect(submitted).toHaveBeenCalled();expect(settled).toHaveBeenCalled();expect(destroyBuffer).toHaveBeenCalledOnce();for(const destroy of destroyTargets)expect(destroy).toHaveBeenCalledOnce();});
