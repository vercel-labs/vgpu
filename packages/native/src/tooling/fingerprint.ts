import {
  metalGenerationProfile,
  type MetalGenerationProfile,
} from "../compatibility.js";
import { canonicalJSON, sha256 } from "../compiler/source.js";
import type { MetalProjectCompilerInput } from "./project.js";

/** Fingerprint an already captured project. Physical paths and output ownership are separate. */
export function fingerprintMetalProject(
  input: MetalProjectCompilerInput,
  profile: MetalGenerationProfile = metalGenerationProfile
): string {
  const hashes = new Map(input.snapshot.inputs.map((source) => [
    source.module,
    source.sha256,
  ]));
  const payload = {
    schemaVersion: 1,
    profile,
    moduleName: input.moduleName,
    programs: input.programs.slice().sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ),
    graph: {
      entries: input.snapshot.entries,
      modules: Object.keys(input.snapshot.modules).sort().map((id) => ({
        id,
        sha256: hashes.get(id),
        imports: input.snapshot.modules[id].imports,
      })),
    },
  };
  return sha256(`vgpu-native-metal-input/v1\0${canonicalJSON(payload)}`);
}
