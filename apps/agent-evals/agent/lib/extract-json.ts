/**
 * Pull the JSON object out of a stream that also carries human-readable noise.
 *
 * `vgpu doctor` writes JSON on stdout, but the Vulkan/Dawn stack it probes
 * writes warnings to the same terminal, and on a misconfigured host they
 * interleave. `JSON.parse(stdout)` is therefore not safe — it fails on exactly
 * the unhealthy machines whose diagnosis we care about most.
 *
 * @returns the substring from the first `{` to the last `}`, or the input
 *   unchanged when there is no object in it, so the caller's own `JSON.parse`
 *   produces an error message containing the real payload.
 */
export function extractJson(text: string): string {
  const value = String(text ?? "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start === -1 || end === -1 || end < start ? value : value.slice(start, end + 1);
}
