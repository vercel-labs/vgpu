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
   one long-lived `Xvfb`, then hovers five seeded waypoints
   (`data-testid="n1-wp-0"`…`4`) in order and screenshots after each.
4. writes `.agent-evals/n1-verify.json` plus the five PNGs into the workspace.

The four gates are exactly those observations: build ok, server up, 5/5
screenshots captured, and every screenshot decodes as a PNG with no two of them
byte-identical. Nothing the agent *says* it ran counts.

Everything else is observed and never gated: an eight-milestone journey
(`vgpu doctor` → WGSL written → `vgpu check` → headless clock-driven test →
`view-image` → integrated into the app → agent-browser set up → its own
screenshot), the `agent_browser_calls_total` vs.
`agent_browser_calls_with_executable_path` counters, a
`feedback_technique=pingPong|hand-rolled|unclear` classifier, and one
**multimodal** judge (`evals/lib/judge-trail.mjs`) that is shown the first and
last screenshots and scores 0-100 whether the second reads as a fading trail
behind the pointer. Its score is soft and its rationale is always logged — the
rationale is the part a human reads.

The waypoint `div`s in the seeded `page.tsx` look like dead markup and are not:
they are the fixed hover targets that make the screenshot pass reproducible
whatever layout the agent's canvas ends up with. The agent is never asked to add
or keep them.

Budget: `timeoutMs` is overridden to **30 minutes** for this eval only, and the
first run against a cold template also pays a one-time ~110 MB
`npx playwright install chromium`. `agent-browser` itself is deliberately **not**
pre-installed — it is the first command in vgpu's own browser guide, so
installing it for the agent would erase the discovery step milestone 7 exists to
measure.

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

Shortcuts for the same three: `pnpm agent-evals:s2`, `pnpm agent-evals:n1`,
`pnpm agent-evals:view-image`.

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

n1 closes the s2 hole — the harness builds, serves and hovers the app itself, so
a forged artifact cannot pass and a claim in the transcript counts for nothing.
Its own v0 gap is one level up: **the screenshot check is presence and
non-identity only.** All it proves is that every capture is a real PNG and that
no two of the five are byte-identical — that the pointer changes *something*. It
does not check that the change is spatially correlated with the waypoint being
hovered, and it does not check that anything fades over time. A shader that
recolors the whole hero on any pointer movement passes those four gates.

What covers that gap today is the multimodal judge, and it is soft on purpose: a
vision model's read of "does this look like a fading trail" is exactly the kind
of signal that should inform a human, not block a run. The next iteration for
this task is to make the spatial claim deterministic — compare the luma delta
inside a window around the hovered waypoint against the frame's own baseline,
across consecutive captures — at which point the judge becomes corroboration
instead of the only evidence.

Two smaller things this task also does not prove: that the effect is *animated*
(nothing samples two frames at the same pointer position), and that vgpu is what
draws it (the integration milestone greps for the import; it is soft, like every
journey signal).

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
2. **Spatial screenshot check for `n1`** — measure the luma delta in a window
   around the hovered waypoint against the frame's own baseline, so "the trail
   follows the pointer and fades" becomes deterministic instead of resting on the
   soft multimodal judge (see "Trust model").
3. **Journey funnel** — the milestones the evals log today become a reported
   funnel across runs (still never a gate: gating ritual rewards ritual).
4. **More tasks** — beyond the gradient and the hero: a real shader bug, a
   texture task, an error-code lookup.
