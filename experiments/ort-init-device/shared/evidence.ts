export interface Evidence { platform: "node" | "browser"; status: "PASS" | "FAIL"; matrix: Record<string,string>; assertions: Record<string, boolean>; snapshot?: unknown; reference?: unknown; lifecycle: string[]; errors: string[] }
export function pass(assertions: Record<string, boolean>): boolean { return Object.values(assertions).every(Boolean); }
export function errorText(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error); }
