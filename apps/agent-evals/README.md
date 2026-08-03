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
agent/                  a neutral coding agent (eve defaults: bash, read/write, glob, grep)
agent/hooks/            after every turn, tars /workspace back to .work/snapshots/<sessionId>/
evals/                  sends the task, then reads the agent's out.png out of that tar
```

The tarball step is the point. The agent must exercise **unreleased** vgpu, so
installing from npm would test the wrong thing, and a `file:` link into the
monorepo would let it read the repo's own sources — the answer — instead of
discovering the library from its published surface.

`pack-vgpu.mjs` computes the dependency closure of `vgpu` rather than hardcoding
a package list, and also builds the private `@vgpu/cli` package, because `vgpu`'s
own build copies the CLI out of it and its `prepack` generates the docs that
`vgpu docs` serves inside the sandbox.

## The task

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

## Running it

```bash
# credentials: one OIDC token covers both the sandbox and the model gateway
npx vercel link --yes --scope vercel-labs --project vgpu
npx vercel env pull                       # writes .env.local (VERCEL_OIDC_TOKEN, 12 h TTL)

nvm use 24                                # eve needs Node 24; this repo pins 22
node --env-file .env.local ./node_modules/.bin/pnpm agent-evals
```

`pnpm agent-evals` preflights the Node version (exit code **2** with an
actionable message if it is too old), packs the branch, then runs the evals.

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

For CI later, note that the 12-hour OIDC token is useless for a scheduled run:
that needs `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` for the
sandbox and a separate `AI_GATEWAY_API_KEY` for the gateway — a Vercel access
token does **not** work as a Gateway bearer token.

### A green run can still print template errors

eve keeps one dev-runtime snapshot per code revision under `.eve/dev-runtime/`
and initialises a sandbox template for each. Older snapshots hold older
`bootstrap` code, so after a few iterations a passing run can log
`failed to initialize sandbox template` for revisions nothing is using. Check
which template the session actually used (the seed-file count and the bootstrap
commands are logged) before chasing it; `rm -rf .eve` clears the noise at the
cost of a cold rebuild.

## Trust model (v0)

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

1. **Verification harness** — re-render the agent's source in a clean workspace
   and grade the PNG that produces, so a forged output cannot pass.
2. **Journey funnel** — the milestones the eval logs today become a reported
   funnel across runs (still never a gate: gating ritual rewards ritual).
3. **More tasks** — beyond the clear-colour smoke: a real shader bug, a texture
   task, an error-code lookup.
