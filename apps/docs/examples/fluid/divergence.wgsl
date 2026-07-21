import { Grid, index_of } from "./fluid-common.wgsl";
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> divergence: array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=grid.size)){return;} let p=vec2i(id.xy); let last=vec2i(grid.size)-1;
 let l=select(velocity[index_of(p-vec2i(1,0),grid.size)].x,0.0,p.x==0); let r=select(velocity[index_of(p+vec2i(1,0),grid.size)].x,0.0,p.x==last.x);
 let b=select(velocity[index_of(p-vec2i(0,1),grid.size)].y,0.0,p.y==0); let t=select(velocity[index_of(p+vec2i(0,1),grid.size)].y,0.0,p.y==last.y);
 divergence[index_of(p,grid.size)]=(r-l)*.5*f32(grid.size.x)+(t-b)*.5*f32(grid.size.y);
}
