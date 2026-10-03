declare module "*.wgsl" {
  const source: import("@vgpu/wgsl").ShaderSource;
  export default source;
}
