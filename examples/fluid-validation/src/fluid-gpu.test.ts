import { describe, expect, test } from 'vitest';
import { init } from 'vgpu/node';

const W = 16, H = 9, N = W * H;
const DIVERGENCE = `
struct Sim { size: vec2u }
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage,read> velocity: array<vec2f>;
@group(0) @binding(2) var<storage,read_write> divergence: array<f32>;
fn ix(p:vec2i)->u32{let q=clamp(p,vec2i(0),vec2i(sim.size)-1);return u32(q.y)*sim.size.x+u32(q.x);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=sim.size)){return;}let p=vec2i(id.xy);let last=vec2i(sim.size)-1;
let l=select(velocity[ix(p-vec2i(1,0))].x,0.0,p.x==0);let r=select(velocity[ix(p+vec2i(1,0))].x,0.0,p.x==last.x);let b=select(velocity[ix(p-vec2i(0,1))].y,0.0,p.y==0);let t=select(velocity[ix(p+vec2i(0,1))].y,0.0,p.y==last.y);divergence[ix(p)]=(r-l)*.5*f32(sim.size.x)+(t-b)*.5*f32(sim.size.y);}`;
const PRESSURE = `
struct Sim { size: vec2u }
@group(0) @binding(0) var<uniform> sim:Sim;@group(0) @binding(1) var<storage,read> src:array<f32>;@group(0) @binding(2) var<storage,read> divergence:array<f32>;@group(0) @binding(3) var<storage,read_write> dst:array<f32>;
fn ix(p:vec2i)->u32{let q=clamp(p,vec2i(0),vec2i(sim.size)-1);return u32(q.y)*sim.size.x+u32(q.x);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=sim.size)){return;}let p=vec2i(id.xy);let i=ix(p);let c=src[i];let last=vec2i(sim.size)-1;let l=select(src[ix(p-vec2i(1,0))],c,p.x==0);let r=select(src[ix(p+vec2i(1,0))],c,p.x==last.x);let b=select(src[ix(p-vec2i(0,1))],c,p.y==0);let t=select(src[ix(p+vec2i(0,1))],c,p.y==last.y);let wx=f32(sim.size.x*sim.size.x);let wy=f32(sim.size.y*sim.size.y);dst[i]=((l+r)*wx+(b+t)*wy-divergence[i])/(2.0*wx+2.0*wy);}`;
const PROJECT = `
struct Sim { size: vec2u }
@group(0) @binding(0) var<uniform> sim:Sim;@group(0) @binding(1) var<storage,read> src:array<vec2f>;@group(0) @binding(2) var<storage,read> pressure:array<f32>;@group(0) @binding(3) var<storage,read_write> dst:array<vec2f>;
fn ix(p:vec2i)->u32{let q=clamp(p,vec2i(0),vec2i(sim.size)-1);return u32(q.y)*sim.size.x+u32(q.x);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=sim.size)){return;}let p=vec2i(id.xy);let last=vec2i(sim.size)-1;let c=pressure[ix(p)];let l=select(pressure[ix(p-vec2i(1,0))],c,p.x==0);let r=select(pressure[ix(p+vec2i(1,0))],c,p.x==last.x);let b=select(pressure[ix(p-vec2i(0,1))],c,p.y==0);let t=select(pressure[ix(p+vec2i(0,1))],c,p.y==last.y);var u=src[ix(p)]-vec2f((r-l)*.5*f32(sim.size.x),(t-b)*.5*f32(sim.size.y));if(p.x==0&&u.x<0){u.x=0;}if(p.x==last.x&&u.x>0){u.x=0;}if(p.y==0&&u.y<0){u.y=0;}if(p.y==last.y&&u.y>0){u.y=0;}dst[ix(p)]=u;}`;

async function projectionFixture(seed: boolean) {
  const gpu = await init();
  try {
    const velocity = gpu.storage(N * 8, 'read-write'); const projected = gpu.storage(N * 8, 'read-write');
    const before = gpu.storage(N * 4, 'read-write'); const after = gpu.storage(N * 4, 'read-write'); const pressure = gpu.pingPongStorage(N * 4);
    const initial = new Float32Array(N * 2);
    if (seed) for (let y=0;y<H;y++) for(let x=0;x<W;x++){const i=(y*W+x)*2;initial[i]=Math.sin(x*.71+y*.23)*.7;initial[i+1]=Math.cos(x*.19-y*.83)*.6;}
    velocity.write(initial); projected.write(new Float32Array(N*2)); pressure.read.write(new Float32Array(N)); pressure.write.write(new Float32Array(N));
    const sim={size:[W,H]}; const div=gpu.compute(DIVERGENCE); const jacobi=gpu.compute(PRESSURE); const project=gpu.compute(PROJECT);
    div.set({sim,velocity,divergence:before}).dispatch(2,2);
    for(let i=0;i<8;i++){jacobi.set({sim,src:pressure.read,divergence:before,dst:pressure.write}).dispatch(2,2);pressure.swap();}
    project.set({sim,src:velocity,pressure:pressure.read,dst:projected}).dispatch(2,2);
    div.set({sim,velocity:projected,divergence:after}).dispatch(2,2);
    const [preBytes,postBytes,projectedBytes,pressureBytes]=await Promise.all([before.read(),after.read(),projected.read(),pressure.read.read()]);
    return { pre:new Float32Array(preBytes),post:new Float32Array(postBytes),projected:new Float32Array(projectedBytes),pressure:new Float32Array(pressureBytes) };
  } finally { gpu.dispose(); }
}
const rms=(a:Float32Array)=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);

describe.skipIf(process.env.VGPU_DOCKER_TEST !== '1')('fluid projection GPU fixtures',()=>{
  test('eight pressure iterations reduce RMS divergence by at least 35%',async()=>{const r=await projectionFixture(true);expect(rms(r.pre)).toBeGreaterThan(0);expect(rms(r.post)).toBeLessThan(rms(r.pre)*.65);});
  test('zero state without forcing remains exactly zero',async()=>{const r=await projectionFixture(false);for(const field of [r.pre,r.post,r.projected,r.pressure]) expect(Array.from(field).every(v=>Object.is(v,0)||Object.is(v,-0))).toBe(true);});
});
