'use client';

import { Component, lazy, Suspense, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { getExampleComponentLoader } from '@/lib/example-components';
import { createDeduplicatedExampleErrorReporter, ExampleErrorReporterProvider } from '@/lib/example-error-reporter';
import { type ExampleSlug } from '@/lib/example-slugs';

interface ExampleCanvasProps {
  slug: ExampleSlug;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function postPreviewError(slug: ExampleSlug, message: string): void {
  window.parent?.postMessage(
    { type: 'vgpu-example-error', slug, message },
    window.location.origin,
  );
}

function ErrorDisplay({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 overflow-auto bg-black/90 p-4 font-mono text-xs leading-5 text-red-200">
      <div className="mb-2 font-sans text-sm font-semibold text-red-100">Preview error</div>
      <pre className="whitespace-pre-wrap">{message}</pre>
    </div>
  );
}

interface PreviewErrorBoundaryProps {
  readonly reportError: (error: unknown) => void;
  readonly children: ReactNode;
}

interface PreviewErrorBoundaryState {
  readonly message: string | null;
}

class PreviewErrorBoundary extends Component<PreviewErrorBoundaryProps, PreviewErrorBoundaryState> {
  state: PreviewErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): PreviewErrorBoundaryState {
    return { message: messageOf(error) };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.reportError(error);
  }

  render() {
    if (this.state.message) return <ErrorDisplay message={this.state.message} />;
    return this.props.children;
  }
}

function ReactExampleCanvas({ slug }: { slug: ExampleSlug }) {
  const loader = getExampleComponentLoader(slug);
  const LazyExample = useMemo(
    () => lazy(() => loader().then((module) => ({ default: module.Example }))),
    [loader],
  );
  return (
    <Suspense fallback={<div className="h-full w-full bg-black" aria-label="Loading example" />}>
      <LazyExample />
    </Suspense>
  );
}

function PreviewHost({ slug }: { slug: ExampleSlug }) {
  const [asyncError, setAsyncError] = useState<string | null>(null);
  const reportError = useMemo(() => createDeduplicatedExampleErrorReporter(
    (error) => setAsyncError(messageOf(error)),
    (error) => postPreviewError(slug, messageOf(error)),
  ), [slug]);

  useEffect(() => {
    const reportWindowError = (event: ErrorEvent) => {
      if (event.error || event.message) reportError(event.error ?? event.message);
    };
    const reportUnhandledRejection = (event: PromiseRejectionEvent) => reportError(event.reason);
    window.addEventListener('error', reportWindowError);
    window.addEventListener('unhandledrejection', reportUnhandledRejection);
    return () => {
      window.removeEventListener('error', reportWindowError);
      window.removeEventListener('unhandledrejection', reportUnhandledRejection);
    };
  }, [reportError]);

  if (asyncError) return <ErrorDisplay message={asyncError} />;
  return (
    <ExampleErrorReporterProvider reportError={reportError}>
      <PreviewErrorBoundary reportError={reportError}>
        <ReactExampleCanvas slug={slug} />
      </PreviewErrorBoundary>
    </ExampleErrorReporterProvider>
  );
}

export function ExampleCanvas({ slug }: ExampleCanvasProps) {
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <PreviewHost key={slug} slug={slug} />
    </div>
  );
}
