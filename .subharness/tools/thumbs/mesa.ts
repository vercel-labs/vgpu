// Checks or updates one example's thumbnail baselines in CI's canonical renderer: the pinned
// linux/amd64 Mesa lavapipe image from infra/snapshots/Dockerfile, the same one the docker-gpu job
// uses for `thumbs:check`. A long-lived container keeps its own install and build, so after the
// first run each call only syncs sources, rebuilds incrementally, and renders.
//
//   node .subharness/tools/thumbs/mesa.ts <slug>            # compare with the committed PNGs
//   node .subharness/tools/thumbs/mesa.ts <slug> --update   # rewrite them only if they differ > 2%
//   node .subharness/tools/thumbs/mesa.ts --stop            # remove this checkout's container
//
// It takes a few minutes the first time (image build + amd64 install), ~15–30 s after; run it in the
// background. Diff images for a failed check land in .context/thumbs/<slug>/.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const dockerfile = path.join(root, "infra/snapshots/Dockerfile");
const image = `vgpu-thumbs-canonical:${hash(readFileSync(dockerfile)).slice(0, 12)}`;
const container = `vgpu-thumbs-${hash(root).slice(0, 10)}`;
const [slug, ...flags] = process.argv.slice(2);

if (slug === "--stop") {
  docker(["rm", "-f", container], { quiet: true });
  console.log(`removed ${container}`);
  process.exit(0);
}
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error("usage: node .subharness/tools/thumbs/mesa.ts <slug> [--update] | --stop");
  process.exit(2);
}
const update = flags.includes("--update");
const started = Date.now();

ensureImage();
ensureContainer();
await syncSources();
exec("prepare", `
  set -e
  lock=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
  if [ "$(cat .vgpu-install-hash 2>/dev/null)" != "$lock" ]; then
    pnpm install --frozen-lockfile && echo "$lock" > .vgpu-install-hash
  fi
  pnpm build
`);
const output = exec("render", update
  ? `pnpm --filter docs thumbs --only ${slug}`
  : `pnpm --filter docs thumbs:check --only ${slug}`, { allowFailure: true });
const lines = output.text.split("\n").filter((line) => line.startsWith(`- ${slug}.`));
if (update) copyOut([`${slug}.card.png`, `${slug}.hero.png`], path.join(root, "apps/docs/public/examples"));
else if (output.code !== 0) copyOut([`${slug}.card.actual.png`, `${slug}.card.diff.png`, `${slug}.hero.actual.png`, `${slug}.hero.diff.png`], path.join(root, ".context/thumbs", slug));
console.log(JSON.stringify({
  slug,
  mode: update ? "update" : "check",
  renderer: "linux/amd64 Mesa lavapipe (infra/snapshots/Dockerfile)",
  ok: output.code === 0,
  results: lines,
  diffs: !update && output.code !== 0 ? path.join(root, ".context/thumbs", slug) : undefined,
  seconds: Math.round((Date.now() - started) / 1000),
  tail: output.code === 0 ? undefined : output.text.split("\n").slice(-25).join("\n"),
}, null, 2));
process.exit(output.code === 0 ? 0 : 1);

function ensureImage(): void {
  if (docker(["image", "inspect", image], { quiet: true, allowFailure: true }).code === 0) return;
  const context = mkdtempSync(path.join(tmpdir(), "vgpu-thumbs-context-"));
  console.error(`building ${image} (linux/amd64, first run only)...`);
  docker(["build", "--platform", "linux/amd64", "-t", image, "-f", dockerfile, context]);
}

function ensureContainer(): void {
  const running = docker(["ps", "-q", "--filter", `name=^${container}$`], { quiet: true }).text.trim();
  if (running) return;
  docker(["rm", "-f", container], { quiet: true, allowFailure: true });
  docker(["run", "-d", "--platform", "linux/amd64", "--name", container, "--label", "vgpu-thumbs=1",
    "-e", "VGPU_DOCKER_TEST=1", "-e", "CI=true", "-w", "/workspace", image, "sleep", "infinity"], { quiet: true });
}

/** Copies every tracked or untracked-but-not-ignored file into the container's /workspace. */
async function syncSources(): Promise<void> {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
  const manifest = `.context/mesa-source-manifest-${process.pid}.txt`;
  const manifestPath = path.join(root, manifest);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${files.join("\n")}\n`);
  // COPYFILE_DISABLE and --no-xattrs keep macOS metadata (._ files, xattrs) out of the archive.
  const tar = spawn("tar", ["--no-xattrs", "--null", "-T", "-", "-cf", "-"], { cwd: root, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const unpack = spawn("docker", ["exec", "-i", container, "sh", "-c", `
    set -e
    cd /workspace
    tar -xf -
    expected=/tmp/vgpu-source-expected.$$
    actual=/tmp/vgpu-source-actual.$$
    trap 'rm -f "$expected" "$actual"' 0 HUP INT TERM
    for scope in apps/docs/examples apps/docs/public/examples; do
      [ -d "$scope" ] || continue
      LC_ALL=C find "$scope" -type f | LC_ALL=C sort > "$actual"
      LC_ALL=C grep "^$scope/" ${manifest} | LC_ALL=C sort > "$expected" || :
      comm -23 "$actual" "$expected" | while IFS= read -r stale; do
        rm -f "$stale"
      done
    done
    rm -f ${manifest}
  `], { stdio: ["pipe", "inherit", "inherit"] });
  tar.stdout.pipe(unpack.stdin);
  tar.stdin.end([...files, manifest].join("\0"));
  try {
    await Promise.all([
      processExit(tar, "source archive"),
      processExit(unpack, `source sync into ${container}`),
    ]);
  } finally {
    rmSync(manifestPath, { force: true });
  }
}

function processExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${label} failed (${code})`)));
  });
}

function copyOut(names: string[], destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of names) {
    docker(["cp", `${container}:/workspace/apps/docs/public/examples/${name}`, path.join(destination, name)], { quiet: true, allowFailure: true });
  }
}

function exec(label: string, script: string, options: { allowFailure?: boolean } = {}) {
  console.error(`[${label}] running in ${container}...`);
  return docker(["exec", container, "sh", "-lc", script], { allowFailure: options.allowFailure, capture: true });
}

function docker(args: string[], options: { quiet?: boolean; allowFailure?: boolean; capture?: boolean } = {}) {
  try {
    const text = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", options.quiet || options.capture ? "pipe" : "inherit"], maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, text };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    const text = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    if (!options.allowFailure) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed:\n${text.split("\n").slice(-30).join("\n")}`);
    return { code: failure.status ?? 1, text };
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
