// A required check belongs to a commit, not a PR. Every open PR that could consume the
// shared result must pass, even when its target branch or description differs.
const supportedBases = new Set(["canary", "main"]);

function snapshot(pr) {
  return {
    number: pr.number, state: pr.state, body: pr.body ?? "",
    head: pr.head.sha, base: pr.base.sha, branch: pr.base.ref,
  };
}

async function inventory(api, eventPr) {
  // The event PR must never disappear because of an eventually consistent association index.
  const current = await api(`pulls/${eventPr.number}`);
  if (current.number !== eventPr.number || current.head.sha !== eventPr.head.sha ||
      current.base.sha !== eventPr.base.sha || current.base.ref !== eventPr.base.ref ||
      current.state !== eventPr.state) {
    throw new Error("Event PR moved; use the workflow run for its current head/base/state.");
  }
  const prs = new Map();
  // Read the open-PR collection directly, not the commit-to-PR association index: a newly
  // opened duplicate must not be omitted merely because commit associations have not caught up.
  for (let page = 1; ; page++) {
    const batch = await api(`pulls?state=open&sort=created&direction=asc&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid open-PR inventory response.");
    for (const pr of batch) {
      if (pr.state !== "open" || !supportedBases.has(pr.base.ref) || pr.head.sha !== eventPr.head.sha) continue;
      if (prs.has(pr.number)) throw new Error("PR inventory changed during pagination; rerun validation.");
      prs.set(pr.number, pr);
    }
    if (batch.length < 100) break;
  }
  const listed = prs.get(current.number);
  if (current.state === "open" && supportedBases.has(current.base.ref)) {
    if (!listed || JSON.stringify(snapshot(listed)) !== JSON.stringify(snapshot(current))) {
      throw new Error("Event PR is missing or stale in the open-PR inventory; rerun validation.");
    }
  } else if (listed) {
    throw new Error("Closed event PR remains in the open-PR inventory; rerun validation.");
  }
  return { event: snapshot(current), prs: [...prs.values()].sort((a, b) => a.number - b.number) };
}

function fingerprint(value) {
  return JSON.stringify({ event: value.event, prs: value.prs.map(snapshot) });
}

export async function validateSharedHeadPrs({ api, eventPr, evaluate }) {
  const before = await inventory(api, eventPr);
  const results = [];
  for (const pr of before.prs) {
    try {
      results.push({ number: pr.number, ...await evaluate(pr) });
    } catch (error) {
      throw new Error(`PR #${pr.number} targeting ${pr.base.ref}: ${error.message}`);
    }
  }
  const after = await inventory(api, eventPr);
  if (fingerprint(before) !== fingerprint(after)) {
    throw new Error("Shared-head PR inventory or descriptions changed during validation; rerun for current PRs.");
  }
  return results;
}
