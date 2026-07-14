import shaderSource from "./shader.wgsl";
import { wgslVitePlugin, type VGPUClientEnvironment } from "vgpu/client";

const defaultEnv: VGPUClientEnvironment = {};
const shaderText: string = shaderSource.wgsl;
const shaderVersion: 1 = shaderSource.version;
const pluginName: string = wgslVitePlugin().name;

export function useShader(env: VGPUClientEnvironment = defaultEnv) {
  return {
    env,
    shader: shaderText,
    shaderVersion,
  };
}
