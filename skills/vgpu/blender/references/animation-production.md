# Preserve motion through runtime export

Read this when exporting or compressing an animated asset. A Blender animation can depend on
constraints, drivers or curve deformation that the runtime format does not represent. Choose an
explicit supported representation before optimizing it, and keep the editable source unchanged.

| Motion | Candidate representation | Check after final decode |
| --- | --- | --- |
| Rigid hinge, wheel or sliding panel | Node transforms with stable hierarchy/pivots | Axis, attachment, intermediate poses and continuous rotation |
| Cable or hose bending between attachments | Skinning or morph targets supported by the importer | Shape and both attachment endpoints across the motion |
| Skeletal character | Supported skin/joint transforms | Deformation, joint limits, normals and animated bounds |
| Fixed repeated prop | Shared static mesh | No unnecessary animation data or per-instance copies |

For example, Blender curve Hooks can move a cable in the authoring scene without becoming glTF
animation. Exporting its rest mesh alone freezes it. Convert the deformation in an export copy,
then compare the decoded cable against Blender at intermediate times. Correct first and last
poses do not establish correct motion between them.

## Establish a reference

Record units, axes, hierarchy, pivots, clip names, start/end times, playback rate and looping
intent. Evaluate source constraints in an export copy. Preserve continuous spins: equivalent
orientations at two keys do not describe how many turns occurred between them.

Choose task-specific error limits at important visible locations: distance at a hand or cable
endpoint, surface deformation error, rotation error or screen-space silhouette loss. Keep the
measured errors separate from those limits. A distant crowd and a close product inspection need
different tolerances.

## Reduce and validate in separate stages

1. Export an uncompressed reference and decode it through the actual importer. Validate its poses,
   transforms, attachments and duration before blaming compression for an existing export error.
2. Reduce redundant keys under the chosen error limit. Sample intermediate times between retained
   keys as well as authored keys. Preserve terminal keys where needed for exact duration and loops.
3. Apply geometry/skin/animation compression, decode again and measure its additional error.
   Do not attribute all error to key reduction or hide a failed stage inside the aggregate.
4. For intended seamless loops, compare pose and velocity at the boundary. Inspect animated bounds,
   culling, shadows and LOD transitions during playback at real speed.

A checker must visit the expected clips, joints and sample times. Retain a deliberately displaced
attachment or broken loop as a positive detection control when building a checker. Empty clips,
nonfinite transforms or absent required samples fail validation; they are not zero error.

Deliver the preserved source, export settings, decoded comparison evidence, measured errors and
remaining unsupported animation features. Do not present a native Blender preview as proof that
the browser reproduces the motion.
