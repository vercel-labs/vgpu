# C1 follow-up: override defaults and selection

This spike asks whether the pinned Tint APIs can produce typed, deterministic override metadata
without reimplementing WGSL constant evaluation.

## Result

Yes. Tint can be the oracle for both declared defaults and partially configured selections, with
one important separation:

- a **default** is the value obtained by evaluating that declaration's initializer with API values
  omitted; it does not by itself prove that an empty pipeline configuration is valid;
- a **selected** value is obtained after applying the request's partial configuration and then
  reevaluating every omitted override that depends on it.

For example, [`all-scalars.wgsl`](./canaries/all-scalars.wgsl) declares `BASE = 4` and
`DEP = BASE * 2`. Tint reports a default of `8` for `DEP`, but configuring only `BASE = 5`
materializes `DEP = 10`. Copying the previously reflected default would incorrectly produce `8`.

The prototype deliberately emits a local evidence format. It does not decide the public contract
for initializer presence or defaults, and this spike does not change any schema or documentation.

## Materialization procedure

[`prototype/main.cc`](./prototype/main.cc) first reflects with Inspector.
`Inspector::Overrides()` supplies module identity, scalar type, explicit-versus-automatic ID, and
initializer presence; `Inspector::GetEntryPoint()` supplies the statically used entry-point set.
Inspector authorizes module identities and is the required-value validation boundary; lowered IR
decides only the effective evidence closure after folding and configuration. Every IR path begins
with `ProgramToLoweredIR()`, the same core-dialect boundary used by Tint's compiler pipeline. The
materializer has three roles:

1. The **selected pass** accepts and converts every module-level explicit input through Tint's
   constant evaluator, including valid constants not statically used by the selected entry point.
   Before any IR pruning, it requires an API value for every statically used declaration without an
   initializer. It then calls `Override::SetInitializer()` before `SingleEntryPoint`. This
   implements WGSL evaluation semantics: a configured override's declared initializer is not
   evaluated, and initializer-only dependencies may leave the effective evidence closure. The pass
   adds one temporary `var<private>` probe initialized from each retained override result.
   `SubstituteOverrides` evaluates the whole selected graph in WGSL order, including short-circuit
   control flow. Each probe initializer becomes a typed IR constant, which is the reported selected
   value.
2. The **default role** repeats on a fresh, unconfigured lowered module for each reported override.
   After `SingleEntryPoint`, Tint's `ReferencedModuleDecls::AddToBlock()` isolates exactly that
   override and its transitive initializer graph; functions and unrelated root declarations are
   removed. A single probe plus `SubstituteOverrides` yields the declared default. A failure in
   that isolated graph is recorded as `requires-configuration`, while an absent initializer stays
   distinguishable as `absent`.
3. The **verification pass** repeats the explicit initializer cuts, runs `SingleEntryPoint`, and
   requires its exact retained override-ID set to match the materialized selected map. It then
   calls `SubstituteOverrides` with that complete map. The gate verifies that no
   `core::ir::Override` remains and that compute workgroup dimensions are constants. This pruning
   canonicalizes local evidence; it never determines whether a statically required value may be
   omitted.

Reflection has to happen before substitution: `SubstituteOverrides` removes the override
instructions and their now-unused initializer graph.

## Required and invalid initializers

[`required-and-subsets.wgsl`](./canaries/required-and-subsets.wgsl) distinguishes four cases:

- `REQUIRED` has no initializer and must be configured because it is statically used by the entry
  point;
- `DEP = REQUIRED + 1` has an initializer but no all-omitted value, so its default evaluation is
  `requires-configuration` and configuring `REQUIRED = 4` selects `DEP = 5`;
- configuring only `DEP = 9` still fails with `MISSING_REQUIRED`; configuring both `DEP` and
  `REQUIRED` succeeds, skips `DEP`'s initializer, and may canonicalize the effective evidence down
  to `DEP`;
- selecting either unrelated entry point removes the inactive required override before
  substitution, so it needs no configuration. A valid module-level config for a declaration not
  statically used by that entry point is nevertheless accepted and omitted from canonical evidence.

This follows two distinct normative rules: WebGPU validates missing defaults over constants
[statically used by the entry point](https://gpuweb.github.io/gpuweb/#abstract-opdef-validating-gpuprogrammablestage),
while WGSL evaluates override expressions only
[after API-provided values are substituted](https://www.w3.org/TR/WGSL/#override-expressions).

Contextual unavailability is not a final validity decision.
[`invalid-initializer.wgsl`](./canaries/invalid-initializer.wgsl) declares `X = 0` and `A = 4 / X`.
The empty-config evaluation of `A` is unavailable, but configuring `X = 2` repairs the initializer
and selects `A = 2`. Configuring `A = 7` directly bypasses its initializer, cuts initialized `X`
from the effective closure, and succeeds with a workgroup size of `7`. With neither override
configured, the selected pass fails with `VGPU-C1-OVERRIDE-INVALID-INITIALIZER`. Unlike
`REQUIRED`, `X` has a default, so the static required-value check does not reject the direct `A`
selection. Evaluating every initializer before applying configuration would incorrectly reject it.

## Lowering and folding canaries

[`select-evaluation.wgsl`](./canaries/select-evaluation.wgsl) catches an important API boundary.
The pre-lowering reader IR contains a WGSL-dialect `select` instruction that the standalone core IR
evaluator does not handle. `ProgramToLoweredIR` converts it to the core dialect consumed by
`SubstituteOverrides`: `N = select(2, 4, A)` defaults to `2`, and configuring `A = true`
materializes `N = 4`. The probe approach deliberately uses the whole transform instead of
evaluating override initializers one at a time.

[`short-circuit.wgsl`](./canaries/short-circuit.wgsl) declares a required `REQUIRED` override behind
`FOLDED = false && REQUIRED`. Inspector conservatively reports both, while lowered
`SingleEntryPoint` folds the dead dependency and retains only `FOLDED`. The empty configuration is
still invalid because `REQUIRED` is statically used and has no initializer. Supplying either value
for `REQUIRED` succeeds and produces identical effective evidence with `FOLDED = false`. This is
why the static required set and post-folding evidence set have different jobs, and why Inspector and
post-folding IR sets must not be compared for exact equality. Exact set equality is reserved for IR
passes with identical preprocessing.

[`configured-condition.wgsl`](./canaries/configured-condition.wgsl) makes the left-hand side another
override. Configuring only `CONDITION = false` still cannot waive the statically required
`REQUIRED` value. Configuring both succeeds and materializes `RESULT = false`; input values affect
evaluation after the static interface has been validated, not which interface values are required.
The isolated no-API pass conservatively reports `RESULT`'s default as `requires-configuration`
because `REQUIRED` has no value. The spike does not claim symbolic completeness for defaults that
cannot occur in a valid empty pipeline configuration.

## Workgroup expressions

[`workgroup-expression.wgsl`](./canaries/workgroup-expression.wgsl) proves that one
`@workgroup_size` axis can depend on more than one override. Its X axis resolves to `5` and carries
the canonical dependency closure `X, Y`; the inactive `UNUSED` declaration is absent.

The spike output preserves both the resolved dimensions and a sorted override-dependency list per
axis so the gate can prove the full `X + Y` closure. That dependency list is test evidence, not
artifact surface. The semantic artifact serializes only resolved `x`, `y`, and `z`: the resolved
source hash and selected override values already invalidate changes, and the runtime does not
consume expression provenance. The spike does not preserve or promise the original WGSL
expression text.

[`forward-reference.wgsl`](./canaries/forward-reference.wgsl) also declares `A = B + 1` before
`B = 2`. The result is `A = 3`; configuring only `B = 4` produces `A = 5`.

## Scalar conversion findings

The gate covers `bool`, `i32`, `u32`, `f32`, and `f16`. Finite floating-point values are serialized
as exact hexadecimal bits after Tint conversion and evaluation.

At revision `8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca`:

- explicit `f32 -0` and `f16 -0` select positive-zero bits `00000000` and `0000`;
- decimal `f16` conversion follows Tint's truncating quantizer, not a host IEEE round-to-nearest
  packer: `1.0007` becomes `3c00`, while `1.0009765625` becomes `3c01`;
- the minimum positive `f32` and `f16` subnormal defaults preserve `00000001` and `0001`;
- the maximum finite defaults preserve `7f7fffff` and `7bff`;
- non-finite input and finite inputs that overflow the target scalar are rejected before
  substitution. This is a strict local spike boundary, not a claim that WebGPU's staged WebIDL
  `double` conversion rejects the same `f16` inputs. The range check compares the original input to
  the exact target limits so a value just outside a boundary cannot first round back to the maximum
  and surface as an internal Tint conversion error.

The full effective map built from the reported selected values is checked against the exact
post-configuration `SingleEntryPoint` ID set and accepted by `SubstituteOverrides`.
For `BASE` and `DEP`, the resolved workgroup size independently exposes the substituted result. For
floating-point, boolean, and signed-integer selections, this spike proves Tint constant-evaluator
conversion, constant bits captured after whole-graph substitution, and successful independent
full-map substitution; it does not claim an observed backend value. Raw request bits are not
treated as translated output.

## IDs and structured errors

The canaries cover both automatic IDs and explicit WGSL `@id(17)`. Names address either kind;
numeric request keys address explicit WGSL IDs only. Tint's automatic internal IDs are reflected as
evidence but are not accepted as stable external keys.

The runner checks deterministic diagnostics for:

- unknown keys; valid module keys are accepted even when entry-inactive;
- duplicate keys and name/explicit-ID conflicts;
- wrong scalar kinds and non-integral integer input;
- non-finite and out-of-range values;
- a missing active required override;
- an invalid initializer whose override is omitted and whose dependencies are not repaired.

## Reproduce

The runner uses only Node built-ins, writes only to an OS-created temporary directory, and never
downloads or installs dependencies. Without a release it runs the static fixture gate and reports
the native portion as skipped:

```sh
./run.sh
```

Run the complete gate against the exact release and compatibility overlay recorded by
[`c1-tint-standalone`](../c1-tint-standalone/provenance/releases.json):

```sh
./run.sh \
  --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include ../tint-compat-include \
  --require-tint
```

The pinned gate verifies the complete installed include tree, `libwebgpu_dawn.a`, and the one-file
`src/utils/compiler.h` overlay before compiling. It builds the prototype twice, requires
byte-identical executables, invokes every behavioral case twice, permutes configuration order, and
relocates identical source while keeping the virtual source name stable.

## Scope boundary

This proves extraction and materialization semantics against a verified feasibility archive. The
archive is arm64, targets a newer macOS than the distribution baseline, and exposes a monolithic
library. It does not close the later source-build, macOS 14, x86_64, direct-target, offline Metal,
signing, or packaging gates.
