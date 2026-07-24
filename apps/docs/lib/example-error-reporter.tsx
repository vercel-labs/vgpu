'use client';

import { createContext, useContext, type ReactNode } from 'react';

export type ExampleErrorReporter = (error: unknown) => void;

export function createDeduplicatedExampleErrorReporter(
  displayError: ExampleErrorReporter,
  postError: ExampleErrorReporter,
): ExampleErrorReporter {
  let reported = false;
  return (error) => {
    if (reported) return;
    reported = true;
    try {
      displayError(error);
    } catch {
      // Error reporting must never interfere with renderer teardown.
    }
    try {
      postError(error);
    } catch {
      // Parent-window delivery is best-effort and isolated from display state.
    }
  };
}

const ExampleErrorReporterContext = createContext<ExampleErrorReporter | null>(null);

interface ExampleErrorReporterProviderProps {
  readonly reportError: ExampleErrorReporter;
  readonly children: ReactNode;
}

export function ExampleErrorReporterProvider({ reportError, children }: ExampleErrorReporterProviderProps) {
  return (
    <ExampleErrorReporterContext.Provider value={reportError}>
      {children}
    </ExampleErrorReporterContext.Provider>
  );
}

/** Reports renderer failures to the preview host without owning renderer lifecycle. */
export function useExampleErrorReporter(): ExampleErrorReporter {
  const reporter = useContext(ExampleErrorReporterContext);
  if (!reporter) throw new Error('Example components must render inside ExampleCanvas.');
  return reporter;
}
