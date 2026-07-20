import { Sim, index_of, cell_uv, segment_weight, emitter_weight } from "./fluid-common.wgsl";
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
fn sample_c(p:vec2f)->vec4f{let g=clamp(p*vec2f(sim.size)-.5,vec2f(0),vec2f(sim.size)-1.0);let a=vec2i(floor(g));let f=fract(g);return mix(mix(src[index_of(a,sim.size)],src[index_of(a+vec2i(1,0),sim.size)],f.x),mix(src[index_of(a+vec2i(0,1),sim.size)],src[index_of(a+vec2i(1,1),sim.size)],f.x),f.y);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=sim.size)){return;}let q=vec2i(id.xy);let p=cell_uv(q,sim.size);var c=exp(-.18/60.0)*sample_c(clamp(p-velocity[index_of(q,sim.size)]/60.0,.5/vec2f(sim.size),1.0-.5/vec2f(sim.size)));
 let phase=f32((sim.step/120u)%3u);let ca=select(vec3f(.05,.45,1.0),vec3f(1.0,.5,.08),phase==2.0);let cb=vec3f(.95,.08,.55);c+=vec4f(ca,1.0)*emitter_weight(p,sim.idle_a)*.075+vec4f(cb,1.0)*emitter_weight(p,sim.idle_b)*.068;if(sim.pointer_active>0.0){c+=sim.pointer_color*segment_weight(p,sim.pointer_from,sim.pointer_to,.035)*.12;}dst[index_of(q,sim.size)]=clamp(c,vec4f(0),vec4f(4));}
