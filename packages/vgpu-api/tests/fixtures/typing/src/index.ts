import shaderSource from "./shader.wgsl";
import type { ShaderReflection as RootReflection } from "vgpu";
import type { ShaderReflection as NodeReflection } from "vgpu/node";
import type { ShaderReflection as MockReflection } from "vgpu/mock";
import { wgslVitePlugin, type ShaderReflection as ClientReflection, type VGPUClientEnvironment } from "vgpu/client";

const defaultEnv: VGPUClientEnvironment = {};
const shaderText: string = shaderSource.wgsl;
const shaderVersion: 2 = shaderSource.version;
const reflection: RootReflection & NodeReflection & MockReflection & ClientReflection = shaderSource.reflection;
const pluginName: string = wgslVitePlugin().name;

export function useShader(env: VGPUClientEnvironment = defaultEnv) {
  return {
    env,
    shader: shaderText,
    shaderVersion,
    reflection,
  };
}
