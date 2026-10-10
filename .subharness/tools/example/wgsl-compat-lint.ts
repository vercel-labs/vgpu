// Static checks for WGSL that core WebGPU (Metal locally) accepts but CI's compatibility-mode Mesa
// renderer rejects or renders differently, so they surface before the slow Mesa thumbnail run.

export interface LintFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const rules: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: "compat: flat interpolation must be `@interpolate(flat, either)`", pattern: /@interpolate\(\s*flat\s*(?:,\s*first\s*)?\)/ },
  { rule: "compat: `linear` interpolation is not supported", pattern: /@interpolate\(\s*linear\b/ },
  { rule: "compat: `sample` interpolation sampling is not supported", pattern: /@interpolate\([^)]*,\s*sample\s*\)/ },
  { rule: "compat: `sample_index` / `sample_mask` builtins are not supported", pattern: /@builtin\(\s*(?:sample_index|sample_mask)\s*\)/ },
  { rule: "compat: cube-array textures are not supported", pattern: /texture_cube_array|texture_depth_cube_array/ },
  { rule: "repo: sine hashes differ across GPUs — use an integer hash (pcg)", pattern: /fract\(\s*sin\(/ },
];

/**
 * Lints WGSL sources line by line, plus one cross-line rule: `textureLoad` on a variable declared as
 * a depth texture (compatibility mode forbids it; bind depth as `texture_2d<f32>` to read it).
 *
 * @example
 *   lintWgslCompat([{ file: "a.wgsl", source: "@location(0) @interpolate(flat) id: u32" }]);
 *   // [{ file: "a.wgsl", line: 1, rule: "compat: flat interpolation must be ...", text: "..." }]
 */
export function lintWgslCompat(files: readonly { readonly file: string; readonly source: string }[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const { file, source } of files) {
    const lines = source.split("\n");
    const depthNames = [...source.matchAll(/var\s+([A-Za-z_]\w*)\s*:\s*texture_depth_/g)].map((match) => match[1]);
    lines.forEach((text, index) => {
      const code = text.replace(/\/\/.*$/, "");
      for (const { rule, pattern } of rules) if (pattern.test(code)) findings.push({ file, line: index + 1, rule, text: text.trim() });
      for (const name of depthNames) {
        if (new RegExp(`textureLoad\\(\\s*${name}\\b`).test(code)) findings.push({ file, line: index + 1, rule: "compat: textureLoad on a depth texture is not supported", text: text.trim() });
      }
    });
  }
  return findings;
}
