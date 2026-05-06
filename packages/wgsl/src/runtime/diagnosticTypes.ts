export type Diagnostic = Error & { code: string; severity?: "error" | "warning"; line?: number; column?: number; range?: unknown; columnPrecise?: boolean; relatedDiagnostics?: readonly { code: string; message: string }[]; metadata?: Record<string, unknown> };
export type DiagnosticList = readonly Diagnostic[];
