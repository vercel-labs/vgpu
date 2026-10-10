/**
 * Renders a thrown value as the text shown in the example preview error overlay.
 *
 * V8 puts `name: message` on the first line of `error.stack`, so reading the stack
 * alone looks complete in Chrome. SpiderMonkey and JavaScriptCore emit call frames
 * only: there the same read drops the one line that says what actually went wrong,
 * leaving a bare dump of minified frames. Compose the headline unless the engine
 * already supplied it.
 */
export function formatPreviewError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const headline = error.message ? `${error.name}: ${error.message}` : error.name;
  const stack = error.stack;
  if (!stack) return headline;
  if (stack.startsWith(headline)) return stack;
  if (error.message && stack.startsWith(error.message)) return stack;
  return `${headline}\n${stack}`;
}
