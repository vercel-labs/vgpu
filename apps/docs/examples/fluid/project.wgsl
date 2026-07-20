import { Sim, index_of } from "./fluid-common.wgsl";
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read> pressure: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec2f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=sim.size)){return;} let p=vec2i(id.xy); let last=vec2i(sim.size)-1; let c=pressure[index_of(p,sim.size)];
 let l=select(pressure[index_of(p-vec2i(1,0),sim.size)],c,p.x==0); let r=select(pressure[index_of(p+vec2i(1,0),sim.size)],c,p.x==last.x);
 let b=select(pressure[index_of(p-vec2i(0,1),sim.size)],c,p.y==0); let t=select(pressure[index_of(p+vec2i(0,1),sim.size)],c,p.y==last.y);
 var u=src[index_of(p,sim.size)]-vec2f((r-l)*.5*f32(sim.size.x),(t-b)*.5*f32(sim.size.y));
 if(p.x==0&&u.x<0.0){u.x=0.0;} if(p.x==last.x&&u.x>0.0){u.x=0.0;} if(p.y==0&&u.y<0.0){u.y=0.0;} if(p.y==last.y&&u.y>0.0){u.y=0.0;}
 let s=length(u); if(s>2.5){u*=2.5/s;} dst[index_of(p,sim.size)]=u;
}
