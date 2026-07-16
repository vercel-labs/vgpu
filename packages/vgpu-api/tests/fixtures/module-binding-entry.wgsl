import { cfg } from "./module-binding-lib.wgsl";
@fragment fn main() -> @location(0) vec4f { return vec4f(cfg.seed); }
