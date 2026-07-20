import { createRequire } from "node:module";
import { resolve } from "node:path";
import { VGPUError } from "@vgpu/core";
import { getCachedDawnBinary, installDawn, type DawnInstallOptions } from "./dawn-installer.ts";

export type WebGPUModule = { create(options: string[]): GPU; globals: Record<string, unknown> };
type Require = NodeJS.Require;
export type DawnResolverOptions = DawnInstallOptions & {
  readonly require?: Require;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
};

const nativeRequire = createRequire(import.meta.url);

export async function resolveWebGPU(options: DawnResolverOptions = {}): Promise<WebGPUModule> {
  const requireImpl = options.require ?? nativeRequire;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (env.VGPU_DAWN_BINARY) {
    const path = resolve(env.VGPU_DAWN_BINARY);
    return requireNative(requireImpl, path, "VGPU_DAWN_BINARY");
  }

  if (platform === "linux") {
    const cached = getCachedDawnBinary(options);
    if (cached) return requireNative(requireImpl, cached, "vgpu cache");
  }

  let stockError: unknown;
  try {
    return requireImpl("webgpu") as WebGPUModule;
  } catch (cause) {
    stockError = cause;
  }

  try {
    const installed = await installDawn({ ...options, env, platform, arch });
    return requireNative(requireImpl, installed.path, "downloaded vgpu prebuild");
  } catch (prebuildError) {
    throw combineResolutionErrors(stockError, prebuildError, platform, arch);
  }
}

function requireNative(requireImpl: Require, path: string, provider: string): WebGPUModule {
  try {
    const loaded = requireImpl(path) as Partial<WebGPUModule>;
    if (typeof loaded.create !== "function" || !loaded.globals) throw new Error("module does not export Dawn create() and globals");
    return loaded as WebGPUModule;
  } catch (cause) {
    const mismatch = glibcMismatch(cause);
    throw new VGPUError({
      code: mismatch ? "VGPU-NODE-GLIBC-MISMATCH" : "VGPU-NODE-NATIVE-LOAD",
      message: mismatch
        ? `Dawn from ${provider} requires GLIBC ${mismatch.required}, but this host reports GLIBC ${mismatch.host ?? "unknown"}.`
        : `@vgpu/adapter-node could not load Dawn from ${provider} (${path}).`,
      fix: mismatch
        ? "Install the portable prebuild with `pnpm exec vgpu install-dawn`, or set VGPU_DAWN_BINARY to a compatible binary. Do not upgrade glibc in place."
        : "Check that the file exists, matches this OS/CPU and Node ABI, and that its shared libraries are installed.",
      where: "createNodeAdapter",
      cause,
    });
  }
}

function combineResolutionErrors(stockError: unknown, prebuildError: unknown, platform: string, arch: string): VGPUError {
  const mismatch = glibcMismatch(stockError);
  if (prebuildError instanceof VGPUError && prebuildError.code === "VGPU-NODE-PREBUILD-MISSING") {
    return new VGPUError({
      code: prebuildError.code,
      message: mismatch
        ? `Stock webgpu requires GLIBC ${mismatch.required}, but this host reports GLIBC ${mismatch.host ?? "unknown"}. ${prebuildError.message}`
        : `Stock webgpu failed to load on ${platform}/${arch}. ${prebuildError.message}`,
      fix: prebuildError.fix,
      where: "createNodeAdapter",
      cause: { stock: stockError, prebuild: prebuildError },
    });
  }
  if (prebuildError instanceof VGPUError) return prebuildError;
  return new VGPUError({
    code: "VGPU-NODE-PREBUILD-MISSING",
    message: `Neither stock webgpu nor the vgpu Dawn prebuild could load on ${platform}/${arch}.`,
    fix: "Run `pnpm exec vgpu install-dawn`, or set VGPU_DAWN_BINARY to a compatible binary.",
    where: "createNodeAdapter",
    cause: { stock: stockError, prebuild: prebuildError },
  });
}

export function glibcMismatch(cause: unknown, detectedHostVersion = hostGlibcVersion()): { required: string; host: string | null } | null {
  const required = String(cause).match(/GLIBC_(\d+\.\d+)/u)?.[1];
  return required ? { required, host: detectedHostVersion } : null;
}

export function hostGlibcVersion(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}
