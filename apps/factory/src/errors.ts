export class FactoryError extends Error {
  readonly exitCode: 1 | 2;

  constructor(
    message: string,
    options: { cause?: unknown; exitCode?: 1 | 2 } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "FactoryError";
    this.exitCode = options.exitCode ?? 1;
  }
}

export class FactoryUsageError extends FactoryError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { ...options, exitCode: 2 });
    this.name = "FactoryUsageError";
  }
}

export class FactoryConfigurationError extends FactoryError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { ...options, exitCode: 2 });
    this.name = "FactoryConfigurationError";
  }
}

export class FactoryRuntimeError extends FactoryError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { ...options, exitCode: 1 });
    this.name = "FactoryRuntimeError";
  }
}

export function exitCodeForError(error: unknown): 1 | 2 {
  return error instanceof FactoryError ? error.exitCode : 1;
}

export function displayError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unknown factory failure.";
}
