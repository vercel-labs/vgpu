import { Sim, index_of } from "./fluid-common.wgsl";
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> divergence: array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=sim.size)){return;} let p=vec2i(id.xy); let last=vec2i(sim.size)-1;
 let l=select(velocity[index_of(p-vec2i(1,0),sim.size)].x,0.0,p.x==0); let r=select(velocity[index_of(p+vec2i(1,0),sim.size)].x,0.0,p.x==last.x);
 let b=select(velocity[index_of(p-vec2i(0,1),sim.size)].y,0.0,p.y==0); let t=select(velocity[index_of(p+vec2i(0,1),sim.size)].y,0.0,p.y==last.y);
 divergence[index_of(p,sim.size)]=(r-l)*.5*f32(sim.size.x)+(t-b)*.5*f32(sim.size.y);
}
