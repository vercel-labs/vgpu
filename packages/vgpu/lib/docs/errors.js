export class DocsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DocsError";
    this.code = code;
    Object.assign(this, details);
  }
}
