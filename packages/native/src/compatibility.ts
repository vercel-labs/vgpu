import {
  compilerIdentity,
  semanticContract,
  translationContract,
} from "./compiler/identity.js";

/** Bump revision for resolution, interpretation, binding or emission changes, not CLI/npm releases. */
export const metalGenerationProfile = Object.freeze({
  revision: 1,
  artifactFormat: "vgpu-metal-package/v1" as const,
  compiler: compilerIdentity,
  semanticContract,
  translationContract,
  metal: Object.freeze({
    sdk: "macosx",
    languageStandard: "macos-metal2.4",
    target: "air64-apple-macos14.0",
  }),
  swift: Object.freeze({
    toolsVersion: "6.0",
    macOSPlatform: "v14",
  }),
});

export interface MetalGenerationProfile {
  readonly revision: number;
  readonly artifactFormat: string;
  readonly compiler: {
    readonly name: string;
    readonly version: string;
    readonly protocol: number;
    readonly upstream: { readonly name: string; readonly revision: string };
  };
  readonly semanticContract: string;
  readonly translationContract: string;
  readonly metal: {
    readonly sdk: string;
    readonly languageStandard: string;
    readonly target: string;
  };
  readonly swift: {
    readonly toolsVersion: string;
    readonly macOSPlatform: string;
  };
}
