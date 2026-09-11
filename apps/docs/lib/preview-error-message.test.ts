import { expect, test } from 'vitest';
import { formatPreviewError } from './preview-error-message';

/** A SpiderMonkey/JavaScriptCore stack: call frames only, no `name: message` header. */
function withFramesOnlyStack(error: Error, frames: string): Error {
  error.stack = frames;
  return error;
}

test('a V8 stack is kept verbatim so the headline is not duplicated', () => {
  const error = new Error('boom');
  error.stack = 'Error: boom\n    at run (https://vgpu.sh/app.js:1:1)';

  const formatted = formatPreviewError(error);

  expect(formatted).toBe(error.stack);
  expect(formatted.split('\n').filter((line) => line.includes('boom'))).toHaveLength(1);
});

test('the headline is prefixed onto a frames-only stack', () => {
  // Firefox rendered this overlay as a bare frame dump: `error.stack` never carries
  // the message there, so the reason for the failure was invisible.
  const error = withFramesOnlyStack(
    new Error('navigator.gpu.requestAdapter() returned null.'),
    'r@https://vgpu.sh/chunk.js:1:6014\nt@https://vgpu.sh/chunk.js:1:15326',
  );

  const formatted = formatPreviewError(error);

  expect(formatted.split('\n')[0]).toBe('Error: navigator.gpu.requestAdapter() returned null.');
  expect(formatted).toContain('r@https://vgpu.sh/chunk.js:1:6014');
});

test('a custom error name is kept in the headline', () => {
  const error = withFramesOnlyStack(new Error('no adapter'), 'VGPUError@https://vgpu.sh/chunk.js:1:1');
  error.name = 'VGPUError';

  expect(formatPreviewError(error).split('\n')[0]).toBe('VGPUError: no adapter');
});

test('an error with no stack falls back to the headline', () => {
  const error = new Error('boom');
  error.stack = undefined;

  expect(formatPreviewError(error)).toBe('Error: boom');
});

test('an error with no message keeps its name', () => {
  const error = withFramesOnlyStack(new Error(''), 'r@https://vgpu.sh/chunk.js:1:1');
  error.name = 'VGPUError';

  expect(formatPreviewError(error).split('\n')[0]).toBe('VGPUError');
});

test('values that are not Errors are stringified', () => {
  expect(formatPreviewError('plain string')).toBe('plain string');
  expect(formatPreviewError(null)).toBe('null');
  expect(formatPreviewError(undefined)).toBe('undefined');
});
