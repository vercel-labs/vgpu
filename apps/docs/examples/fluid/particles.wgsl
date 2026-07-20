struct Config { aspect:f32, _pad:vec3f }
@group(0) @binding(0) var<uniform> config:Config;
struct VOut{@builtin(position) position:vec4f,@location(0) local:vec2f,@location(1) color:vec4f,@location(2) age:f32}
@vertex fn vertex_main(@location(0) local:vec2f,@location(1) particle_position:vec2f,@location(2) particle_color:vec4f,@location(3) particle_radius:f32,@location(4) particle_age:f32)->VOut{var o:VOut;let stretch=vec2f(particle_radius/config.aspect,particle_radius*1.45);o.position=vec4f((particle_position*2.0-1.0)+local*stretch*2.0,0,1);o.local=local;o.color=particle_color;o.age=particle_age;return o;}
@fragment fn fragment_main(in:VOut)->@location(0) vec4f{let d=length(in.local);let a=(1.0-smoothstep(.45,1.0,d))*in.color.a;return vec4f(in.color.rgb*a,a);}
