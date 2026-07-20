import { Sim, index_of } from "./fluid-common.wgsl";
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> divergence: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=sim.size)){return;} let p=vec2i(id.xy); let i=index_of(p,sim.size); let c=src[i]; let last=vec2i(sim.size)-1;
 let l=select(src[index_of(p-vec2i(1,0),sim.size)],c,p.x==0); let r=select(src[index_of(p+vec2i(1,0),sim.size)],c,p.x==last.x);
 let b=select(src[index_of(p-vec2i(0,1),sim.size)],c,p.y==0); let t=select(src[index_of(p+vec2i(0,1),sim.size)],c,p.y==last.y);
 let wx=f32(sim.size.x*sim.size.x); let wy=f32(sim.size.y*sim.size.y); dst[i]=((l+r)*wx+(b+t)*wy-divergence[i])/(2.0*wx+2.0*wy);
}
