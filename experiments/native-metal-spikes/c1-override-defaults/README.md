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
for initializer presence or defaults, and this spike does not change any public schema. The format
keeps two views with different jobs: `staticOverrides` is the exact Inspector-authorized interface
that feeds semantic artifacts and compiler requests, while `overrides` is the post-configuration,
post-folding closure retained as diagnostic evidence. Every success also carries `sourceSha256`,
computed from the exact WGSL bytes read by the materializer, so the serialized result cannot be
reused with different source text that happens to have the same virtual name.

## Materialization procedure

[`prototype/main.cc`](./prototype/main.cc) is now only a standalone adapter: it reads and hashes the
source, parses WGSL once, calls the worker-adjacent
[`override-materializer`](../c1-compiler-protocol/prototype/override-materializer.h), and preserves
the spike's JSON evidence format. The pure C++ engine receives a validated `tint::Program`, one or
two selected entry names and stages, and typed boolean-or-number configuration. It cross-checks
each requested stage against Tint and owns no file I/O, hashing, JSON, process, or platform API.
The engine is placed beside the worker so both semantic extraction and translation can link it in a
later slice; the current worker executable does not link it yet.

The engine performs program-wide work before iterating over selected entries:

1. A **reflection plan** calls `Inspector::Overrides()` once for module identity, scalar type,
   explicit-versus-automatic ID, and initializer presence. It calls `Inspector::GetEntryPoint()`
   once per requested entry to validate its stage and collect its statically used override IDs,
   then forms one canonical static union. Inspector authorizes module identities and is the
   required-value validation boundary.
2. **Configuration normalization** resolves every public identifier once and converts each supplied
   value through Tint's constant evaluator in one lowered module. The resulting typed bits are used
   directly by later passes; they are never widened to `double` and narrowed again.
3. The **static union pass** starts from one fresh lowered module, installs the normalized inputs,
   and takes every override in the canonical union as a root.
   `ReferencedModuleDecls::AddToBlock()` preserves their combined initializer graph after configured
   initializer cuts, while removing functions and unrelated declarations. One probe per retained
   override plus `SubstituteOverrides` yields the bit-exact canonical `staticOverrides` shared by
   every selected entry.
4. The **default pass** evaluates each union member once in a fresh, unconfigured lowered module.
   `ReferencedModuleDecls::AddToBlock()` isolates that override and its transitive initializer graph
   without entry-point pruning. A single probe plus `SubstituteOverrides` yields the declared
   default. A failure in that isolated graph is recorded as `requires-configuration`, while an
   absent initializer stays distinguishable as `absent`.
5. Only then does the engine iterate over entries. Each **effective and verification pass** installs
   configured values before `SingleEntryPoint`, implementing WGSL semantics in which configuring an
   override skips its initializer and can remove initializer-only dependencies. Temporary
   `var<private>` probes plus `SubstituteOverrides` produce the effective typed evidence. A second
   lowered module verifies the exact retained override-ID set, installs that complete selected map,
   checks that no `core::ir::Override` remains, and requires positive constant compute workgroup
   dimensions. Each effective record must be a bit-identical subset of the already materialized
   static union.

Every IR path begins with `ProgramToLoweredIR()`, the same core-dialect boundary used by Tint's
compiler pipeline. Entry-point pruning canonicalizes local evidence; it never determines whether a
statically required value may be omitted.

Reflection has to happen before substitution: `SubstituteOverrides` removes the override
instructions and their now-unused initializer graph.

## Required and invalid initializers

[`required-and-subsets.wgsl`](./canaries/required-and-subsets.wgsl) distinguishes four cases:

- `REQUIRED` has no initializer and must be configured because it is statically used by the entry
  point;
- `DEP = REQUIRED + 1` has an initializer but no all-omitted value, so its default evaluation is
  `requires-configuration` and configuring `REQUIRED = 4` selects `DEP = 5`;
- configuring only `DEP = 9` still fails with `MISSING_REQUIRED`; configuring both `DEP` and
  `REQUIRED` succeeds, skips `DEP`'s initializer, retains both in `staticOverrides`, and
  canonicalizes the effective `overrides` evidence down to `DEP`;
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
from the effective closure, retains `A = 7` and `X = 0` in the static interface, and succeeds with
a workgroup size of `7`. With neither override configured, the selected pass fails with
`VGPU-C1-OVERRIDE-INVALID-INITIALIZER`. Unlike
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
post-folding IR sets must not be compared for exact equality. The static view still retains the
chosen `REQUIRED` value, so changing it changes normalized semantics even when effective evidence
and MSL are identical. Exact set equality is reserved for IR passes with identical preprocessing.

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
post-configuration `SingleEntryPoint` ID set and accepted by `SubstituteOverrides`. Independently,
the static map is checked against Inspector's exact entry set, materialized in one isolated Tint
pass, and required to contain the effective map with bit-identical values.
For `BASE` and `DEP`, the resolved workgroup size independently exposes the substituted result. For
floating-point, boolean, and signed-integer selections, this spike proves Tint constant-evaluator
conversion, constant bits captured after whole-graph substitution, and successful independent
full-map substitution; it does not claim an observed backend value. Raw request bits are not
treated as translated output.

## IDs and structured errors

The canaries cover both automatic IDs and explicit WGSL `@id(17)`. Configuration uses WGSL's one
pipeline-overridable constant identifier: the authored name when there is no `@id`, or the canonical
base-10 string (`"17"`) when there is one. The authored name of an explicit-ID declaration,
noncanonical numeric spellings such as `"017"`, and Tint's automatic internal IDs are rejected.
Automatic IDs remain standalone JSON evidence but never escape the engine API; only an authored
`@id` is retained as optional provenance.

The runner checks deterministic diagnostics for:

- unknown keys; valid module keys are accepted even when entry-inactive;
- duplicate identifiers, noncanonical IDs, and an authored name used in place of `@id`;
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
relocates identical source while keeping the virtual source name stable. A second direct API gate
materializes two entries in one call, checks their stages and exact/effective subsets, and requires a
canonical union whose shared record agrees bit for bit. The core independently caps selected entries
at 2, configuration and program unions at 4,096, aggregate memberships at 8,192, names and
identifiers at 256 bytes, and diagnostic messages at 16 KiB.

## Scope boundary

This proves extraction and materialization semantics against a verified feasibility archive. The
archive is arm64, targets a newer macOS than the distribution baseline, and exposes a monolithic
library. The separate direct-source gate closes the compiler worker's macOS 14 arm64/x86_64 build;
this materializer fixture does not itself validate offline Metal, signing, artifact assembly, or
packaging.
