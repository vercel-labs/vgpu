import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
const mocks = vi.hoisted(() => ({ init: vi.fn() })); vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));
import { Controls } from './controls'; import { createRenderer, renderThumbnail } from './renderer'; import { AA_MODE_FXAA, AA_MODE_OFF, DEFAULT_ANTI_ALIASING_CONTROLS } from './types';
function setup() {
 vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() }); vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn()); const disconnect=vi.fn(); vi.stubGlobal('ResizeObserver', class { observe=vi.fn(); disconnect=disconnect; });
 const set=vi.fn(), compile=vi.fn(async()=>{}), stop=vi.fn(), buffer={ gpu:{ destroy:vi.fn() }, write:vi.fn() }; const target=()=>({size:[100,50],format:'rgba8unorm',resize:vi.fn(),destroy:vi.fn()}); const surface={size:[100,50],format:'bgra8unorm',dispose:vi.fn()};
 const gpu={time:0,device:{createBuffer:vi.fn(()=>buffer)},dispose:vi.fn(), fns: {surface:vi.fn(()=>surface),target:vi.fn(target),draw:vi.fn(()=>({set,compile})),effect:vi.fn(()=>({set,compile})),sampler:vi.fn(()=>({})), frameLoop: vi.fn(()=>({stop})) }}; mocks.init.mockResolvedValueOnce(gpu); const canvas={getBoundingClientRect:()=>({width:100,height:50})} as HTMLCanvasElement; return {canvas,gpu,set,stop,surface,disconnect};
}
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
test('shares the FXAA default with the accessible controlled select',()=>{const html=renderToStaticMarkup(createElement(Controls, { value: DEFAULT_ANTI_ALIASING_CONTROLS, onChange: () => {} }));expect(DEFAULT_ANTI_ALIASING_CONTROLS.mode).toBe(AA_MODE_FXAA);expect(html).toContain('aria-label="Anti-aliasing mode"');expect(html).toContain('value="3" selected');});
test('updates mode without recreating and disposes idempotently',async()=>{const e=setup();const r=createRenderer({canvas:e.canvas});await r.ready;const before=e.gpu.fns.draw.mock.calls.length;r.setControls?.({mode:AA_MODE_OFF});r.setControls?.({mode:AA_MODE_OFF});expect(e.gpu.fns.draw.mock.calls.length).toBe(before);r.dispose();r.dispose();expect(e.stop).toHaveBeenCalledOnce();expect(e.surface.dispose).toHaveBeenCalledOnce();expect(e.disconnect).toHaveBeenCalledOnce();});


test('rejects the original init error, reports once, and tears down even when onError throws',async()=>{vi.stubGlobal('window',{devicePixelRatio:1,addEventListener:vi.fn(),removeEventListener:vi.fn()});const failure=new Error('init failed');mocks.init.mockRejectedValueOnce(failure);const onError=vi.fn(()=>{throw new Error('callback failed');});const renderer=createRenderer({canvas:{} as HTMLCanvasElement,onError});await expect(renderer.ready).rejects.toBe(failure);expect(onError).toHaveBeenCalledOnce();renderer.setControls?.({mode:AA_MODE_OFF});expect(onError).toHaveBeenCalledOnce();});


test('cancellation fulfills silently without reporting an error',async()=>{vi.stubGlobal('window',{devicePixelRatio:1,addEventListener:vi.fn(),removeEventListener:vi.fn()});const onError=vi.fn();const renderer=createRenderer({canvas:{} as HTMLCanvasElement,onError});renderer.dispose();await expect(renderer.ready).resolves.toBeUndefined();expect(onError).not.toHaveBeenCalled();});

test('thumbnail compilation failure waits for submitted work and releases owned resources',async()=>{const failure=new Error('compile failed'),destroyBuffer=vi.fn(),settled=vi.fn(async()=>{}),submitted=vi.fn(async()=>{}),destroyTargets=[vi.fn(),vi.fn(),vi.fn()];let targetIndex=0;const gpu={device:{createBuffer:()=>({gpu:{destroy:destroyBuffer},write:vi.fn()})},gpu:{queue:{onSubmittedWorkDone:submitted}},settled, fns: {draw:()=>({set:vi.fn(),compile:vi.fn(async()=>{throw failure})}),effect:()=>({set:vi.fn(),compile:vi.fn(async()=>{})}),sampler:()=>({}),target:()=>({size:[64,64],format:'rgba8unorm',destroy:destroyTargets[targetIndex++]}) }} as never;const output={size:[64,64],format:'rgba8unorm'} as never;await expect(renderThumbnail(gpu,output)).rejects.toBe(failure);expect(submitted).toHaveBeenCalled();expect(settled).toHaveBeenCalled();expect(destroyBuffer).toHaveBeenCalledOnce();for(const destroy of destroyTargets)expect(destroy).toHaveBeenCalledOnce();});
