/** Shared protocol identity; importing it does not initialize schemas or launch tools. */
export const compilerIdentity = Object.freeze({
  name: "vgpu-tint-compiler",
  version: "0.1.0",
  protocol: 1,
  upstream: Object.freeze({
    name: "dawn/tint",
    revision: "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca",
  }),
});

export const semanticContract = "vgpu-native-tint-semantic-extraction/v1";
export const translationContract = "vgpu-native-tint-compiler/v1";
