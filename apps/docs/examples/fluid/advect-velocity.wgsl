import { Sim, index_of, cell_uv, segment_weight, emitter_weight } from "./fluid-common.wgsl";

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;

fn sample_u(p: vec2f) -> vec2f {
  let g = clamp(p * vec2f(sim.size) - .5, vec2f(0), vec2f(sim.size) - 1.0);
  let a = vec2i(floor(g)); let f = fract(g);
  return mix(mix(src[index_of(a, sim.size)], src[index_of(a + vec2i(1,0), sim.size)], f.x),
             mix(src[index_of(a + vec2i(0,1), sim.size)], src[index_of(a + vec2i(1,1), sim.size)], f.x), f.y);
}
fn curl(p: vec2i) -> f32 {
  let dx = 1.0 / f32(sim.size.x); let dy = 1.0 / f32(sim.size.y);
  return (src[index_of(p+vec2i(1,0),sim.size)].y-src[index_of(p-vec2i(1,0),sim.size)].y)/(2.0*dx)
       - (src[index_of(p+vec2i(0,1),sim.size)].x-src[index_of(p-vec2i(0,1),sim.size)].x)/(2.0*dy);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= sim.size)) { return; }
  let q=vec2i(id.xy); let p=cell_uv(q,sim.size); let h=1.0/60.0;
  var u=.998*sample_u(clamp(p-h*src[index_of(q,sim.size)], .5/vec2f(sim.size), 1.0-.5/vec2f(sim.size)));
  let c=curl(q); let grad=vec2f(abs(curl(q+vec2i(1,0)))-abs(curl(q-vec2i(1,0))), abs(curl(q+vec2i(0,1)))-abs(curl(q-vec2i(0,1))));
  let n=grad/max(length(grad),1e-5); u += h * 0.00065 * vec2f(n.y,-n.x)*c;
  let wa=emitter_weight(p,sim.idle_a); let wb=emitter_weight(p,sim.idle_b);
  let ta=vec2f(.28*.73*cos(.73*f32(sim.step)/60.0), .22*1.09*cos(1.09*f32(sim.step)/60.0+.4));
  let tb=vec2f(.26*.61*cos(.61*f32(sim.step)/60.0+3.14159265), .24*.97*cos(.97*f32(sim.step)/60.0+2.1));
  u += h*(wa*(2.2*ta+vec2f(-ta.y,ta.x)*1.7)+wb*(2.2*tb-vec2f(-tb.y,tb.x)*1.7));
  if (sim.pointer_active > 0.0) { let w=segment_weight(p,sim.pointer_from,sim.pointer_to,.035); u += h*w*(sim.pointer_velocity*1.8 + vec2f(-sim.pointer_velocity.y,sim.pointer_velocity.x)*.32); }
  let s=length(u); if(s>2.5){u*=2.5/s;} dst[index_of(q,sim.size)]=u;
}
