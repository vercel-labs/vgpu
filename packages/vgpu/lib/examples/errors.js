export class ExamplesError extends Error {
  constructor(code, message, exitCode = 5, details) { super(message); this.name = 'ExamplesError'; this.code = code; this.exitCode = exitCode; this.details = details; }
}
export const usage = (message) => new ExamplesError('VGPU-EXAMPLES-USAGE', message, 2);
export const notFound = (message) => new ExamplesError('VGPU-EXAMPLES-NOT-FOUND', message, 3);
export const network = (message) => new ExamplesError('VGPU-EXAMPLES-NETWORK', message, 4);
export const integrity = (message) => new ExamplesError('VGPU-EXAMPLES-INTEGRITY', message, 5);
export const filesystem = (message) => new ExamplesError('VGPU-EXAMPLES-FILESYSTEM', message, 7);
export function errorResult(error) {
  const e = error instanceof ExamplesError ? error : filesystem(error instanceof Error ? error.message : String(error));
  return { code: e.exitCode, stderr: `${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } })}\n` };
}
