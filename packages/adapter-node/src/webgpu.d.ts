declare module "webgpu" {
  export function create(options: string[]): GPU;
  export const globals: Record<string, unknown>;
}
