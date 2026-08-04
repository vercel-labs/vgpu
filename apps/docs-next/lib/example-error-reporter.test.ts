import { expect, test, vi } from 'vitest';
import { createDeduplicatedExampleErrorReporter } from './example-error-reporter';

test('the first renderer failure is displayed and posted exactly once', () => {
  const displayError = vi.fn();
  const postError = vi.fn();
  const reportError = createDeduplicatedExampleErrorReporter(displayError, postError);
  const first = new Error('GPU initialization failed');

  reportError(first);
  reportError(new Error('duplicate callback'));

  expect(displayError).toHaveBeenCalledOnce();
  expect(displayError).toHaveBeenCalledWith(first);
  expect(postError).toHaveBeenCalledOnce();
  expect(postError).toHaveBeenCalledWith(first);
});

test('a throwing display callback does not suppress error delivery', () => {
  const postError = vi.fn();
  const reportError = createDeduplicatedExampleErrorReporter(
    () => { throw new Error('display unavailable'); },
    postError,
  );
  const failure = new Error('GPU initialization failed');

  expect(() => reportError(failure)).not.toThrow();
  expect(postError).toHaveBeenCalledOnce();
  expect(postError).toHaveBeenCalledWith(failure);
});

test('a throwing delivery callback does not escape the reporter', () => {
  const displayError = vi.fn();
  const reportError = createDeduplicatedExampleErrorReporter(
    displayError,
    () => { throw new Error('postMessage unavailable'); },
  );
  const failure = new Error('GPU initialization failed');

  expect(() => reportError(failure)).not.toThrow();
  expect(displayError).toHaveBeenCalledOnce();
  expect(displayError).toHaveBeenCalledWith(failure);
});
