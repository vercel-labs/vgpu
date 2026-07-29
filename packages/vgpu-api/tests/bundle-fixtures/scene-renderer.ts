/**
 * Reserved experience fixture for #205.
 *
 * `createSceneView` does not exist in the T202 clean cut and this fixture must not fake its cost by
 * importing an internal renderer or anything from `vgpu/scene`. T202-06 keeps it discoverable but
 * the experience checker marks it deferred until #205 supplies a public renderer entrypoint.
 */
export const sceneRendererExperience = "deferred until #205 creates the public scene renderer";
