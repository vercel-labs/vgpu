# Preflight and Recovery

Use this workflow for long bakes and scripted asset delivery. Keep a short manual edit lightweight; add checkpoints where repeating expensive work or confusing stale output is a real risk. These are asset execution requirements, independent of how many people or agents perform the work.

## Exercise the actual execution path first

Before an expensive run, provide and run a task-local preflight command using the same executable, working directory, dependency environment and helper paths as the intended run. Reuse existing project checks where possible. A version query or import from another directory is not an execution probe.

- Start native Blender and execute a minimal scene operation through Python. For scripted runs, use `--python-exit-code 1`; inspect logs and the expected output, not exit status alone.
- Exercise the chosen render/bake device with a tiny representative bake, then export, encode/decode and import a small fixture through the actual exporter and runtime loader. Await codec initialization. Resolve copied Node helpers from their real execution directory and module mode; a successful ESM import does not establish that a copied CommonJS helper can resolve its dependencies.
- Classify required and optional inputs before baking. Verify required files, codecs, writable output paths and capture dependencies. Missing optional metadata must have a documented fallback or be omitted deliberately, not fail final assembly after a completed bake.
- Capture and read one real target-renderer frame with the intended browser/image tools. Record the actual backend; a fallback renderer does not validate the requested backend. This probe establishes that the tools work, not final visual quality.

If a probe fails, fix or report that boundary before starting dependent expensive work. Do not keep retrying the unchanged failure. If sources may change during a run, execute an immutable snapshot including local imports; record external dependencies and verify snapshot hashes at completion.

## Keep stages independently recoverable

Give expensive stages explicit commands, inputs, outputs and validation. A task-local script may expose subcommands or separate entry points; no particular build framework is required. Do not force a bake when that asset does not need one.

| Stage | Evidence needed before its outputs can be reused |
| --- | --- |
| Prepare | Saved source/LOW checkpoint, resolved transforms and reproducible parameters |
| Validate geometry | Openings, contacts, normals and UV checks on evaluated/exported LOW; simple-material views, including relevant LODs |
| Bake | Lossless masters, actual pass settings and dependency identities, coverage and representative pixel checks |
| Export | Decodable serialized meshes, map/UV bindings and measured counts; reconcile exporter changes with prepared geometry |
| Package | Required files, decoded texture error, channels/mips and delivery manifest with hashes |
| Verify runtime | Actual target-backend captures from matched cameras, independent map toggles, measured costs and renderer errors |

For each attempt, save the exact command, input/dependency hashes, tool identities, exit outcome, output hashes, validation results and failure reason. Mark a stage complete only after its outputs pass its checks. Keep failed attempts and logs distinct from completed checkpoints. File existence or a successful process alone is not proof of completion.

On retry, start at the earliest invalid stage and revalidate dependent outputs. If packaging fails after a verified bake/export, resume packaging from those artifacts; do not regenerate the scene merely to rerun a copy step. When geometry, normals or lighting change, use the [bake dependency rules](baking-and-diagnostics.md#reuse-bakes-by-their-dependencies) to decide which passes need new identities.

## Validate a candidate before replacing delivery assets

Keep candidate assets separate from the last working delivery. Verify the candidate manifest and served build/asset identities before capture; avoid a preview that silently loads missing files from the old asset set. Promote only the validated files together with their matching manifest, retain a recoverable previous version, and smoke-check the delivered URL after replacement. Report whether the replacement is atomic; per-file writes do not make the whole asset set atomic.

Checks establish structural and runtime evidence, not aesthetic acceptance. Pair them with the matched visual review in the [asset workflow](../index.md#6-verify-the-observable-result).
