export type CompileStage = "source" | "validation" | "translation" | "metal";

export class MetalCompileError extends Error {
  constructor(
    readonly stage: CompileStage,
    message: string,
    options: { cause?: unknown; diagnostics?: readonly unknown[] } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "MetalCompileError";
    this.diagnostics = options.diagnostics ?? [];
  }

  readonly diagnostics: readonly unknown[];
}
