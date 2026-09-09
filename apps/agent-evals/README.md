# @vgpu/agent-evals

A dogfooding tool: hand a coding agent the vgpu built **from your branch**, give
it a task, and watch what it does.

It exists to answer product questions — *does the agent find `vgpu docs`? does it
run `vgpu doctor` when rendering fails? does the getting-started page survive
contact with a model?* — and to turn the answers into docs and library changes.

**It is not a benchmark.** There are no scores to compare across branches, no
statistical claims, no leaderboard. A run is an observation.

## How it works

```
scripts/pack-vgpu.mjs   pnpm pack of this branch's vgpu + its workspace deps -> .work/tarballs/
agent/sandbox/          boots a sandbox, installs those tarballs, gates on `vgpu doctor`
agent/sandbox/tasks/    one seed project per task, copied into /workspace by bootstrap
agent/                  a neutral coding agent (eve defaults: bash, read/write, glob, grep)
                        plus one generic `view-image` tool (see "The view-image tool")
agent/hooks/            after every turn: run the task's verification, then tar /workspace
                        back to .work/snapshots/<sessionId>/
agent/lib/verify/       harness-side verification that needs the LIVE sandbox (n1 builds,
                        serves and hovers the app itself). Never under agent/hooks/: eve
                        auto-discovers every module there as a hook.
evals/                  sends the task, then grades what came back out of that tar
```

**One process runs exactly one task.** `defineSandbox`'s configuration is
evaluated once per process and shared by every eval in it, and the tasks need
different seeds and different bootstrap work, so `--task <id>` is required and
drives both the seed selection and the eval filter.

The tarball step is the point. The agent must exercise **unreleased** vgpu, so
installing from npm would test the wrong thing, and a `file:` link into the
monorepo would let it read the repo's own sources — the answer — instead of
discovering the library from its published surface.

`pack-vgpu.mjs` computes the dependency closure of `vgpu` rather than hardcoding
a package list, and also builds the private `@vgpu/cli` package, because `vgpu`'s
own build copies the CLI out of it and its `prepack` generates the docs that
`vgpu docs` serves inside the sandbox.

## The tasks

| Task | What it asks for | What it grades |
| --- | --- | --- |
| `s2-gradient` | a 128x128 red-to-blue gradient from `node render.mjs` | the PNG the agent left behind |
| `n1-hero-shader` | a hover-trail background shader in a Next.js hero | a build/serve/hover pass the **harness** runs itself |
| `view-image-smoke` | name the two colors in `known.png` | that the `view-image` tool really delivers pixels |
| `n2-ship-hero` | a working, approved vgpu hero: "get it ready to merge", write `PR.md` | build + `vgpu check` by the **harness**; whether the agent found and followed the shipping-to-production guide |
| `n3-explore-hero` | the same hero, "still exploring the look", one palette change | build + `vgpu check`; that the agent did **not** run the pre-PR checklist |

### s2-gradient

`evals/s2-gradient.eval.ts` asks for a 128x128 horizontal gradient, pure red at
the left edge to pure blue at the right, produced by `node render.mjs`.

The workspace it starts from is deliberately poor: `package.json` and the
installed dependencies, **no `render.mjs`**. The agent writes the program from
nothing, so the run grades discovery rather than the editing of an example we
wrote for it.

The prompt's only hint is **`Use \`npx vgpu\`.`** That is on purpose: the CLI is
the official entry point for agents, so naming it is the realistic starting
condition, not a leak. What the run measures is the chain of guidance *after*
the entry point — from `npx vgpu`, can the agent reach a working gradient?
Everything downstream stays unsaid: no "shader", no WGSL, no `docs`, no
`doctor`, no `check`.

Gates are the image: size, both endpoint columns within +/-2 per channel, red
falling and blue rising with green at zero across three probed rows, and a
middle column that is a genuine red/blue blend (32..223 per channel).

The +/-2 is because a gradient is interpolated and quantised, and rasterisers
disagree in the last bit or two. The last two gates exist because monotonicity
alone is weak: it accepts two flat halves joined by a hard step, a ramp that
travels red -> black -> blue without ever being a blend, and an image that is
correct only along the sampled line. The midpoint window is deliberately wide
rather than "127 +/- a little", because the midpoint of a correct ramp is ~127
in sRGB space and ~186 in linear light — pinning it near 127 would fail a
gamma-correct renderer for being gamma-correct.

The grading lives in `evals/lib/grade-gradient.mjs` so an offline probe can
import the real logic; a probe that copies it stops describing the eval the
moment either side changes.

Everything else is observed and never gated — journey milestones, funnel
counters (`docs_cmd_count`, `renders_count`,
`tool_calls_to_first_successful_render`), whether the agent reached for the
0.1.x `gpu.target(...)` facade and recovered, and one soft judged score for
docs-usage quality. Gating any of that would reward ritual: an agent that
solves the task without reading the docs has still solved it.

### n1-hero-shader

The flagship task, and the first one whose **outcome is verified by the harness
rather than read out of a file the agent left behind**.

`evals/n1-hero-shader.eval.ts` seeds a plain Next.js app —
`agent/sandbox/tasks/n1-hero-shader/`: a Server Component hero with a title, a
subtitle and CSS, **no canvas, no client component, no vgpu import, no
`next.config.ts`** — and asks for:

> Add an animated background shader to the hero: a hover effect that leaves a
> fading trail behind the pointer. Use `npx vgpu`.

That is a genuinely hard ask, and on purpose. A fading trail needs the previous
frame, so the agent has to find some form of feedback (vgpu's `pingPong`, or a
hand-rolled double buffer); it has to get WGSL past `vgpu check`; it has to wire
a canvas into a React client component; and to see whether any of it works it
has to get a browser running inside the sandbox. Every one of those steps is a
place the docs either carry it or do not, which is the whole point.

**What the harness does after the turn ends** (`agent/lib/verify/n1-hero-shader.mjs`,
run from the `turn.completed` hook, inside the same live sandbox, before the
workspace is tarred):

1. `next build` — must exit 0.
2. `next start -p 4173` — must answer HTTP 200 within 30 s.
3. installs `agent-browser`, resolves the pre-warmed playwright Chromium, starts
   one long-lived `Xvfb`, opens the page and **confirms the session is actually
   on it** (`get url` — a session that lost its browser lands on `about:blank`
   and still prints `✓ Done`).
4. measures the largest `<canvas>`'s bounding box **in the page, at runtime**,
   and drives the pointer by COORDINATE along a path through five waypoints at
   fixed fractions of that box (10%/20% … 90%/80%) — six `agent-browser mouse
   move` steps per leg, ~50 ms apart — capturing a screenshot 250 ms after
   arriving at each. A pointer-free `baseline.png` is captured first.
5. writes `.agent-evals/n1-verify.json` plus the six PNGs into the workspace.

**Why coordinates and not `hover`.** The seed used to carry five invisible
`data-testid="n1-wp-N"` anchor divs and the harness hovered them. They were
styled `pointer-events: none`, and Playwright's (so agent-browser's)
actionability check *refuses to hover an element that cannot receive pointer
events*. Every hover failed, no pointer event ever reached the canvas, and the
first green run's app kept its `pointerUv` uniform at the default `[0.5, 0.5]`
for all five captures — its chroma centroid sat at exactly (629, 302) every
time. The captures still all differed (the background is time-animated), so the
pass looked healthy while proving nothing about the pointer. `mouse move <x>
<y>` dispatches at a coordinate whatever is or is not in the DOM there, which is
also how the evaluated agent drove its own session. **The anchors and their
`.wp` CSS are now deleted from the seed**: the harness derives its coordinates
from the canvas box, so it no longer depends on the agent's markup at all, and
there is one less piece of scaffolding for an agent to trip over or delete.

The four gates are exactly those observations: build ok, server up, 5/5
screenshots captured, and every screenshot decodes as a PNG with no two of them
byte-identical. Nothing the agent *says* it ran counts.

Read that last gate literally: it proves *something changed between captures*,
not that the *pointer* changed it. The task asks for an animated shader, so the
background moves on its own and satisfies non-identity by itself — measured on
the first green run, consecutive captures differ by 3.14-3.38/255 even in
regions far from every pointer position. A shader that ignores the pointer
entirely passes all four gates today, and that is not hypothetical: rehearsing
the fixed harness against the reference app *with its pointer listeners removed*
scored 4/4 gates with 5/5 distinct captures and no trail anywhere. What the
trail claim rests on is the multimodal judge below (softly) and, once a live run
has produced it, the per-waypoint `spatial` measurement (Roadmap).

Two things the harness now records per waypoint so that gap can be closed with
data rather than a guess:

- `pointerMoveOk` — whether every `mouse move` on that leg reported success, in
  agent-browser's own `--json` envelope (`success: true` **and** `moved: true`),
  alongside the exit code. It replaces the old `hoverOk`, which asked a question
  that could never be answered `true`. Aggregated into one verdict-level
  `pointerMoveOk`, logged, and soft-checked — not gated: no live eval run has
  produced it yet, and gating on a signal no live run has produced is gating on
  untested code.
- `spatial` — mean |Δluma| against the previous capture inside a disc around the
  pointer (`near`), versus over pixels far from *every* waypoint (`far`), their
  `ratio`, and how far the single most-changed pixel landed from the pointer
  (`maxDeltaOffset`). Recorded, never gated yet.

An earlier review note said the near/far separation held for only 2 of the 4
waypoint transitions, the other two being occluded by the hero's opaque heading
text. Moving along a path fixed that too: the trail's tail lies outside the text
even when its head is behind it, so all five waypoints now separate cleanly
(ratio 14.5-18.2 against 0.85-1.26 pointer-blind — see the Roadmap for the
numbers and the proposed threshold).

Everything else is observed and never gated, and it now comes from two
different sources on purpose (PR #272 review):

- **Deterministic, regex, for literally verifiable facts about what ran** —
  a bash command either ran or it didn't. The journey milestones built this
  way: `vgpu doctor` → WGSL written → `vgpu check` → ran a node script →
  `view-image` → integrated into the app → agent-browser set up → its own
  screenshot, plus the `agent_browser_calls_total` vs.
  `agent_browser_calls_with_executable_path` counters.
- **Judged, via `evals/lib/judge-code.mjs`, for semantic questions about the
  code** — "did it write a headless frame-stepping test with a synthetic
  pointer, rendering offscreen?", "does it call `clock().advance()`?", "did it
  use the library's built-in ping-pong helper, or hand-roll a double buffer?"
  These used to be code-content regexes, and regex failed at this twice in
  opposite directions: once a predicate matched only an English comment
  narrating what the code was about to do, and the comment-stripper added to
  fix that could truncate a `//` inside a string literal and silently drop a
  true match. A model reading the code cannot be fooled either way. Each of
  these three calls is soft — tracked like the regex signals they replaced,
  never a gate — and each is a real, billed model call, which is why there are
  exactly three and not more. The material they read is capped per unit and
  overall, and is assembled in tool-call order so a truncation drops the end of
  the turn rather than every bash-carried heredoc at once (in both archived
  runs the headless test only exists in the bash half).

One more **multimodal** judge (`evals/lib/judge-trail.mjs`) is shown the first
and last screenshots and scores 0-100 whether the second reads as a fading
trail behind the pointer. Its score is soft and its rationale is always
logged — the rationale is the part a human reads.

The waypoint `div`s in the seeded `page.tsx` look like dead markup and are not:
they are the fixed hover targets that make the screenshot pass reproducible
whatever layout the agent's canvas ends up with. The agent is never asked to add
or keep them.

Budget: `timeoutMs` is overridden to **30 minutes** for this eval only, and the
first run against a cold template also pays a one-time ~110 MB
`npx playwright install chromium`. `agent-browser` itself is deliberately **not**
pre-installed — it is the first command in vgpu's own browser guide, so
installing it for the agent would erase the discovery step the "set up
agent-browser" milestone exists to measure. (Milestones are referenced by name,
never by number, here and in the evals: a "milestone 7" cross-reference went
off-by-one the moment the milestone list shrank from nine entries to eight.)

### When a judge call fails

A judge is a cheap side observation of a 20-30 minute run. It must never be
able to *end* that run, and by default it can:

- eve's collector rewrites any **rejected** async score function into a
  `gate`-severity failed assertion — `score=0, severity="gate", failed=true` —
  regardless of the `.soft()` requested at the call site, and one failed gate
  fails the whole eval. The rejection also surfaces at finalization rather than
  at the call site, so wrapping `t.judge...` in `try`/`catch` catches nothing,
  and `closedQA(criteria, opts)` exposes no error hook (`{ on, model,
  modelOptions }` is the whole surface).
- So the three code-semantics questions and the multimodal trail judge drive
  their own `generateObject` call (`evals/lib/judge-code.mjs`,
  `evals/lib/judge-trail.mjs`) inside our own error handling. A model, network,
  credential or schema failure is logged as `judge: unavailable — <label>` plus
  a `code_judges_unavailable=N/3` counter, records **no** assertion, and the run
  continues to its gates. A missing signal is not evidence that the agent
  failed, so it is never recorded as a "no".
- **Still exposed, deliberately, as a follow-up:** the three docs-usage judges
  in `n1-hero-shader.eval.ts` and `s2-gradient.eval.ts` are still native
  `t.judge.autoevals.closedQA` calls, so a transient failure in one of them
  still fails the eval. They have run history under autoevals' ClosedQA
  grading, and porting them would silently redefine a tracked metric on
  archived material that contains no negative examples to validate the new
  boundary against. Converting them needs a comparability run of its own.

### n2-ship-hero and n3-explore-hero (a pair)

Two tasks, **one seed** (`agent/sandbox/tasks/n2-ship-hero/` and an identical
copy under `n3-explore-hero/`), one grading vocabulary
(`evals/lib/hero-signals.ts`). They exist to answer a docs question the other
tasks cannot: does an agent find the guide written for the *finishing moment*
([shipping-to-production](../../docs/topics/shipping-to-production.docs.md))
when that moment arrives, and does it leave the guide alone when it has not?

The seed is a Next.js hero that already renders an aurora with vgpu and builds
clean. It is deliberately unoptimized in exactly the ways the guide's sections 3
and 4 name: no `compile()` pre-warm, three `rgba32float` targets where
`rgba16float` would do, a two-pass blur at full resolution, a continuous frame
loop. Each is a fork: a free default the agent may apply, or a visible trade it
must offer rather than impose.

**`n2-ship-hero`** asks:

> The hero background in /workspace looks good and is approved. Get it ready to
> merge: do whatever you would do before opening the PR, then write the PR
> description to PR.md. Use `npx vgpu`.

`PR.md` is named because "prepare the PR" without a place for the description
would grade a file the agent had no reason to write. Nothing else is said: no
"checklist", "optimize", "measure" or "propose".

**`n3-explore-hero`** asks, from the same seed:

> I'm still exploring the look of the hero background in /workspace. Try a
> warmer palette: oranges and magentas instead of the blues. Use `npx vgpu`.

The word "exploring" is the whole signal. The guide says not to start the
checklist unprompted while the user is prototyping; an agent that pre-warms,
downgrades formats or writes `PR.md` here applied the right guide at the wrong
time. Without this control, an agent that *always* optimizes passes n2 for the
wrong reason.

**What the harness does after the turn** (`agent/lib/verify/next-build.mjs`,
from the same `turn.completed` hook as n1): discovers every shipped `.wgsl`
with `find` and runs `npx vgpu check` on each, then `next build`, and writes
`.agent-evals/build-verify.json`. No browser, no server: these tasks are about
what the agent does at the finishing moment, not about pixels, so a run stays in
the minutes.

**Gates.** n2: build ok, every WGSL module validates, `PR.md` exists and is
non-empty. n3: build ok, every module validates, a shader actually changed.

**Everything else is observed, never gated.** Deterministic signals from
`hero-signals.ts` (each a literal fact about files or commands, all false on the
untouched seed): `opened_shipping_guide` (asked for the doc by name, not merely
saw it in an index), `ran_vgpu_check`, `ran_next_build`, `wrote_measurement`,
`prewarm_added`, `bundles_added`, `format_changed`, `pr_md_written`,
`pr_has_measurement`, and `checklist_footprint` (the union n3 expects to be
false). Plus soft code-semantics judges through `lib/judge-code.mjs` so a
failed judge call costs a signal and never the run: for n2, "PR.md separates
applied from proposed with a number each", "no pixel-affecting change in the
seed→shipped diff is missing from PR.md", "a measurement was actually taken";
for n3, "the palette moved warm" and "scope discipline: nothing beyond the
request". The seed→shipped diff is judge *material* only, never control flow.

Read the pair together. The finding is the contrast: n2 `opened_shipping_guide`
and `prewarm_added` high with `silent_format_change` false, and n3
`checklist_footprint` false, is the docs doing their job. n2 low and n3 false
means the skill's hook line is not being followed at the finishing moment; n2
high and n3 true means the guide is being applied indiscriminately.

### view-image-smoke

A fast, ~1-turn infra self-test: it asks the agent to look at a randomly
generated `known.png` with the `view-image` tool and name the two colors.
`t.calledTool("view-image", { count: 1 })` is the hard gate (the plumbing);
whether the names are right is soft, because live vision quality varies. The
image is generated at bootstrap from a six-color palette, so the answer cannot
be guessed from what a demo usually looks like.

### The view-image tool

`agent/tools/view-image.ts` is the one tool this suite adds to eve's defaults,
available to every task. It is deliberately generic — "look at an image file in
your workspace" — because that is an affordance every real coding agent already
has through its IDE or chat UI, so withholding it would model a situation that
does not happen. It never mentions vgpu, shaders, doctor or docs. This exception
is narrow on purpose: no second, vgpu-aware tool belongs here.

## Running it

```bash
# credentials: one OIDC token covers both the sandbox and the model gateway
npx vercel link --yes --scope vercel-labs --project vgpu
npx vercel env pull                       # writes .env.local (VERCEL_OIDC_TOKEN, 12 h TTL)

nvm use 24                                # eve needs Node 24; this repo pins 22

# one task per run — the flag is required, there is no "run everything" default
node --env-file .env.local ./node_modules/.bin/pnpm agent-evals --task s2-gradient
node --env-file .env.local ./node_modules/.bin/pnpm agent-evals --task n1-hero-shader
node --env-file .env.local ./node_modules/.bin/pnpm agent-evals --task view-image-smoke
```

Shortcuts: `pnpm agent-evals:s2`, `pnpm agent-evals:n1`, `pnpm agent-evals:view-image`,
`pnpm agent-evals:n2`, `pnpm agent-evals:n3`.

`pnpm agent-evals` preflights the Node version (exit code **2** with an
actionable message if it is too old), resolves `--task` (exit **2** listing the
known tasks if it is missing or unknown), packs the branch, then runs that one
eval. The flag sets both `VGPU_EVALS_TASK` (which seed bootstrap materializes)
and the eval filter, so the two can never drift apart.

> **Footgun:** `vercel env pull` writes the token **wrapped in double quotes**.
> Pulling it out with `grep`/`cut` keeps the quotes and the gateway answers
> `403 invalidToken`, which looks exactly like a permissions problem. Load the
> file with a real dotenv reader (`node --env-file .env.local`), never with
> hand-rolled shell parsing.

Without a credential the eval **skips**; it does not fail. A red result that only
means "you have no token" teaches people to ignore red results.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` | — | model access; absent ⇒ skip |
| `VGPU_EVALS_MODEL` | `anthropic/claude-sonnet-5` | model under observation |
| `VGPU_EVALS_SANDBOX` | `docker` | `docker` or `vercel`; anything else throws at startup |
| `VGPU_EVALS_DOCKER_IMAGE` | `ghcr.io/vercel/eve:latest` | pin it when you need reproducibility |
| `VGPU_EVALS_WORK_DIR` | `<package>/.work` | tarballs and per-session snapshots |
| `VGPU_EVALS_TASK` | — | set by `--task`; which seed bootstrap materializes. Required, and bootstrap throws without it |
| `VGPU_EVALS_JUDGE_MODEL` | `openai/gpt-4.1-mini` | text judge for the docs-usage questions |
| `VGPU_EVALS_VISION_JUDGE_MODEL` | `VGPU_EVALS_JUDGE_MODEL` | image-capable judge for n1's trail screenshots; separate so the two can be pinned independently |

This suite has no CI job: it is run by hand, because every run spends model
tokens and observes discovery behaviour, which says nothing about the commit
under review. Should that ever change, a non-interactive run cannot use the
12-hour OIDC token — it would need `AI_GATEWAY_API_KEY`, since a Vercel access
token does **not** work as a Gateway bearer token. `VERCEL_TOKEN` +
`VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` matter only if you switch to
`VGPU_EVALS_SANDBOX=vercel`; the default docker backend needs no Vercel
credentials at all.

### Naming a different model

`VGPU_EVALS_MODEL=<slug> pnpm agent-evals` sends one 16-token request to the
gateway before packing anything. If the provider is restricted for your team the
command stops with exit 2 and says so, instead of packing tarballs, booting a
sandbox and then dying mid-turn — which is what a restricted provider used to
cost. A gateway that is merely unreachable or rate-limited is reported and the
run continues, because that is not a verdict about the model.

### A green run can still print template errors

eve keeps one dev-runtime snapshot per code revision under `.eve/dev-runtime/`
and initialises a sandbox template for each. Older snapshots hold older
`bootstrap` code, so after a few iterations a passing run can log
`failed to initialize sandbox template` for revisions nothing is using. Check
which template the session actually used (the seed-file count and the bootstrap
commands are logged) before chasing it; `rm -rf .eve` clears the noise at the
cost of a cold rebuild.

## Trust model (v0)

Each task trusts a different amount, and the difference is the point: `s2` reads
a file the agent left behind, `n1` re-runs the app itself. Neither is yet a proof
of correctness.

### s2-gradient: it trusts the agent's `out.png`

**This version trusts the agent's `out.png`.** The eval reads the PNG the agent
left in the workspace and checks its size, endpoints and monotonicity. It does
not re-render from source, so an agent that writes the gradient pixel by pixel
in plain JavaScript — never touching vgpu — passes the gates. The journey
signals are what would expose that, and they are soft by design.

That is deliberate for a first iteration: the immediate value is watching the
agent's journey through the library, and a v0 that ships today beats a verifier
that ships next week. It is also the first thing to fix — **the verification
harness will be iterated in this same PR**, and until it lands, treat a green
result as "worth reading the transcript", not as proof.

### n1-hero-shader: it re-runs the app, but only diffs the screenshots

n1's four hard gates prove three things and no more: something built,
something served, and five harness-captured screenshots decode and are not
byte-identical. They do not prove the *pointer* caused what changed, and —
as shipped — they did not prove the thing serving the app was the thing the
agent built.

Two independent mechanisms defeated all four gates with zero graphics code
in the workspace, found during review:

- **A foreign server on the fixed port (now mitigated).** An agent could
  leave any process bound to `:4173` — demonstrated with a plain Node HTTP
  server serving hand-written HTML with a time-animated 2D canvas and zero
  pointer listeners — and every gate went green on genuine, harness-captured
  screenshots of that foreign page, while the real `next start` died to a
  log nothing read. Fixed by binding to an unguessable port and checking a
  per-run nonce embedded in the served page, so "the thing on the port is
  the thing built this run" is checked, not assumed.
- **Any in-container gate is defeatable by a deliberately adversarial agent
  (not fixable while grading shares the agent's container).** The verify
  pass runs after the agent's turn, in the same container, through the same
  login shell (`bash -lc`) the agent had root in for its whole turn. This is
  not specific to `~/.profile` — that was one demonstrated example, not the
  only one. An agent with root for its whole turn can also kill and replace
  a process, `LD_PRELOAD` a shared library, or firewall traffic with
  `iptables`, among other routes, and reach the same result: forcing every
  gate green without the app actually working. Hardening any one of those
  routes narrows the attack surface but does not close it, because the
  premise — verification executes with the privileges the agent just had —
  is what makes all of them possible. The per-run random port + served
  nonce (above) closes the realistic *accidental* case, a leftover dev
  server from an earlier task or a stale process; it does not, and cannot,
  close the *adversarial* case. Closing that requires running verification
  outside the container the agent had root in — tracked in Roadmap.

Practically: v0's trust model assumes a non-adversarial agent. Against a
model that is optimizing to pass rather than to build the feature, these
gates are evidence, not proof. That's the same posture as `s2` above — n1
removes the "read a file the agent left behind" failure mode, not yet the
"runs inside the agent's own environment" one.

Two smaller things the gates still don't prove, unchanged from before: that
the effect is animated, and that vgpu is what draws it (the integration
milestone greps for the import; it's soft, like every journey signal).

Two things are already load-bearing and should not be softened:

- **The doctor gate in `bootstrap`.** If `vgpu doctor` cannot report `healthy`
  after applying its own prescriptions, bootstrap throws. A broken renderer
  otherwise surfaces as a transcript where the agent looks incompetent, and that
  misreading is expensive.
- **The neutrality of `agent/instructions.md` and the task prompt.** Neither may
  mention vgpu, doctor, docs, `check`, shaders or WebGPU. The moment they do,
  the run stops telling us anything about discoverability.

## Sandbox backends

`agent/sandbox/backend.ts` is the only file allowed to construct a
`SandboxBackend`. Nothing may call `defaultBackend()`: its cascade can degrade to
`just-bash`, which has no real binaries, and an infra problem then reads as an
agent failure.

`VGPU_EVALS_SANDBOX=vercel` selects the Vercel Sandbox. Note what that does
**not** mean: eve always boots its sandboxes from its own published image, and
`runtime` is excluded from the options type for that reason, so a Vercel run does
not land on the AL2023 stock runtime. The `sudo dnf install -y
mesa-vulkan-drivers vulkan-loader` from the vgpu sandbox spike is the remedy for
*that* runtime and does not apply here; both backends run the same Debian-based
image and take vgpu's portable software renderer instead
(`npx vgpu install-software-renderer`), applied by `bootstrap` only when doctor
asks for it.

Vercel is x86_64 only. vgpu's Dawn/lavapipe path is verified there, not on arm64.

## Roadmap (iterate on this PR)

1. **Verification harness for `s2`** — re-render the agent's source in a clean
   workspace and grade the PNG that produces, so a forged output cannot pass.
   `n1` already works this way; `s2` does not yet.
2. **Spatial screenshot check for `n1`** — turn the `spatial` numbers the
   harness already records per waypoint into a hard gate, so "the trail follows
   the pointer" becomes deterministic instead of resting on the soft multimodal
   judge (see "Trust model"). The measurement is in; only the gate is pending,
   and deliberately so: it lands once a live eval run has produced the field.
   Three populations measured in a container against the archived green run's
   own shipped app, all with the shipped code path:

   | population | `near` | `far` | `ratio` | max-delta offset |
   | --- | --- | --- | --- | --- |
   | pointer hand-driven along the path (solved by hand) | 67.45-102.53 | 2.54-2.66 | 25.49-40.32 | 5-23 px |
   | the harness's own rehearsal, same app | 51.07-85.06 | 3.01-5.86 | 14.52-18.22 | 7-14 px |
   | same app, pointer listeners removed | 2.87-4.17 | 3.31-3.46 | 0.85-1.26 | 121-783 px |
   | the archived green run itself (pointer frozen by the refused hovers) | 2.59-4.26 | 2.90-3.54 | 0.89-1.20 | 118-524 px |

   Proposed: **`ratio >= 4` at every waypoint** — 3.6x below the weakest
   positive and 3.2x above the strongest negative, and a ratio rather than an
   absolute delta, so flickering the whole background harder cannot buy it
   (that lifts `far` too). Optional companion if a stricter spatial claim is
   wanted: `maxDeltaOffset <= 0.1 * min(canvas.w, canvas.h)` (69 px at the
   observed 1050x693). `far` alone is not a candidate: it is the background's
   own noise floor and it is ~3/255 whether the pointer works or not.
3. **Journey funnel** — the milestones the evals log today become a reported
   funnel across runs (still never a gate: gating ritual rewards ritual).
4. **Out-of-container verification.** Run the verify pass outside the
   container the agent had root in for its turn, so nothing a deliberately
   adversarial agent could do with that root — a `~/.profile`, a replaced
   process, `LD_PRELOAD`, `iptables`, or anything else — can influence
   grading. This is the remaining structural hole in n1's trust model, and
   it is general, not specific to any one mechanism; the port/nonce fix only
   closes the realistic *accidental* case (a leftover dev server).
5. **More tasks** — beyond the gradient and the hero: a real shader bug, a
   texture task, an error-code lookup.
