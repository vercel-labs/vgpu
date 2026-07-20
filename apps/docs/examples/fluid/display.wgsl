import { Sim, index_of } from "./fluid-common.wgsl";
@group(0) @binding(0) var<uniform> sim:Sim;
@group(0) @binding(1) var<storage,read> dye:array<vec4f>;
fn sample_c(p:vec2f)->vec3f{let g=clamp(p*vec2f(sim.size)-.5,vec2f(0),vec2f(sim.size)-1.0);let a=vec2i(floor(g));let f=fract(g);return mix(mix(dye[index_of(a,sim.size)].rgb,dye[index_of(a+vec2i(1,0),sim.size)].rgb,f.x),mix(dye[index_of(a+vec2i(0,1),sim.size)].rgb,dye[index_of(a+vec2i(1,1),sim.size)].rgb,f.x),f.y);}
@fragment fn fragment_main(@builtin(position) position:vec4f)->@location(0) vec4f{let uv=position.xy/sim.output_size;let c=sample_c(uv);let glow=1.0-exp(-c*1.35);let vignette=.68+.32*pow(max(0.0,1.0-dot(uv-.5,uv-.5)*1.9),1.5);let base=vec3f(.003,.005,.014);return vec4f((base+glow)*vignette,1);}
