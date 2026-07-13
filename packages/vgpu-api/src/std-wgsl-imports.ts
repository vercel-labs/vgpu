const stdModules: Record<string, string> = {
  "@vgpu/wgsl-std/light": `
fn lambert(normal: vec3f, lightDirection: vec3f, lightColor: vec3f, intensity: f32) -> vec3f {
  let n = normalize(normal);
  let l = normalize(-lightDirection);
  return lightColor * max(dot(n, l), 0.0) * intensity;
}
`,
};

/** Inline tiny runtime std WGSL modules so gpu.draw() can stay synchronous. */
export function inlineStdWgslImports(source: string): string {
  return source.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']([^"']+)["'];?\s*$/gm, (_match, spec: string) => {
    const module = stdModules[spec];
    if (!module) return _match;
    return module.trim();
  });
}
