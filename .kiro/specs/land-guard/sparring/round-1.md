# Sparring round 1 — in_progress

Session: `893833a9-f1ad-474b-8dbf-5767a4fbfba5` · plan hash `58d9e3595b7e34a9f3d2ff4902a00d40c851661a695a890555306a942388fa4e`

## Summary

The plan is well-scoped and most of its premises about the existing code hold. The new `land-guard.mjs` adds mechanical enforcement for sequencing rules that are currently text-only, without touching any protected gate file. I found one notable gap regarding the governance-path constraint on `scripts/collab/**`, one issue about the plan's claim about an open plan number that cannot be verified, and a minor issue about the `release` command's interaction with `queue.mjs release`'s `--stale` flag.

## Findings

### R1-F1 [major]

The lane declares `executor: kiro` and `reviewer_seat: agent:vitana-lane-reviewer`, and lists `scripts/collab/land-guard.mjs` and `scripts/collab/land-guard.test.mjs` as its paths. `scripts/collab/**` is a governance path (GOVERNANCE_PATHS at queue.mjs:85). A Kiro lane with `reviewer_seat: agent:vitana-lane-reviewer` CAN change governance paths per VTID-05276 (queue.mjs:72-73), but the plan does not mention this governance-path interaction at all — it only says 'none of these files is protected'. It needs to explicitly acknowledge the governance-path rule and confirm that the `agent:vitana-lane-reviewer` reviewer gives the lane permission to touch `scripts/collab/**`. This matters because if the reviewer_seat were wrong or absent, the lane's PR would be refused by `validate` and `scope-check`.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:82` — // VTID-05213: paths that only an `executor: claude` lane may change (governance: CI, rules, steering, automations,
// this script, the seat map). A Kiro lane that declares or touches one is refused by validate and scope-check —
// VTID-05276: unless the lane's reviewer is a reviewer agent and its permissions come from a trusted source.
export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:71` — // VTID-05276 (plan kiro-autonomy-fallback §4.1): reviewer agents — a `reviewer_seat` value that is not a Kiro seat. A
// lane with `executor: kiro` and `reviewer_seat: agent:vitana-lane-reviewer` may change governance paths (never a
// protected gate file); its review entries come from the agent's own session id.
export const REVIEWER_AGENTS = ['agent:vitana-lane-reviewer'];

Suggestion: Explicitly note in the plan that `scripts/collab/land-guard.mjs` and its test are governance paths, that the lane uses the VTID-05276 reviewer-agent exception to be allowed to touch them, and that none of the touched files matches a protected-gate-file glob. This ensures the implementer sets up the lane file correctly and CI doesn't reject it.

### R1-F2 [minor]

The plan's `release` command wraps `queue.mjs release` but does not address the `--stale` flag. `queue.mjs release` (line 893) accepts `{ stale }` which allows breaking another session's claim after 24h. The plan says 'release runs queue.mjs release' but doesn't say whether it ever passes `--stale`. If land-guard never passes `--stale`, that's fine but should be stated explicitly, since the guard is meant to be the sole release path and stale-claim recovery is a real operational scenario (the plan driver takes over stale claims per collaboration.md §8).

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:893` — export function release(repo, key, session, { stale = false, now = Date.now() } = {}) {
  parseKey(key);
  git(repo, ['fetch', '--prune', 'origin']);
  const c = listClaims(repo).find((x) => x.key === key);
  if (!c) return { ok: true, note: 'no claim' };
  const isStale = now - c.at > STALE_CLAIM_MS;
  if (c.session !== session && !(stale && isStale)) {
    return { ok: false, holder: c.session, note: stale ? 'claim is younger than 24 h' : 'held by another session (use --stale for a claim older than 24 h, and log it on the spec)' };
  }
  git(repo, ['push', 'origin', '--delete', `${CLAIM_PREFIX}${key}`]);
  git(repo, ['fetch', '--prune', 'origin']);
  return { ok: true, broke: c.session !== session ? c.session : null };
}

Suggestion: Clarify whether land-guard's release command accepts and forwards a `--stale` flag (for driver takeover scenarios) or deliberately omits it (forcing direct `queue.mjs release --stale` for that case). If it omits it, note that stale-claim breaks are an escape hatch outside the guard.

### R1-F3 [minor]

The plan references 'Open plan #4392 (`kiro-web-reliability`)' as owning `kiro-web-session.mjs`, `AGENTS.md`, `driver.md` and `preflight.mjs`. No spec directory named `kiro-web-reliability` exists in `.kiro/specs/` at the pinned commit. The plan number #4392 cannot be verified against the codebase. If this plan does not exist or has a different slug, the file-ownership claim is unsubstantiated and could lead to path conflicts at implementation time.

- `exafyltd/vitana-platform:.kiro/pipeline/driver.md:1` — # Plan driver — Kiro Web (one continuous session) — VTID-05271

One driver per approved plan runs it 24/7, weekends included, from the `plan(` PR to Gate 2 (`.claude/rules/collaboration.md`
§8 and §8a). This file is the sequential version of the pipeline for **one Kiro Web
session**: every step runs in this session, one after the other.
- `exafyltd/vitana-platform:scripts/collab/preflight.mjs:1` — #!/usr/bin/env node
/**
 * VTID-05336 — preflight: every CI governance check of a lane or `plan(` PR, locally, in one pass
 * (plan pipeline-speed §2.6 / D5, lane `preflight`).

Suggestion: Verify the actual slug and PR number of the plan that owns those files, or remove the reference if it's a planned-but-not-yet-created spec. If the plan doesn't exist yet, state that the file-ownership constraint is anticipated and name the mechanism that will prevent conflicts (e.g. 'these files are not in this plan's paths').

### R1-F4 [minor]

The plan's `merge` command (step 4) checks `behind_by == 0` and sends `PUT …/merge` with squash, but does not mention the protected-gate-file check that is part of the §7b merge rule (common-rules.md:23-24, collaboration.md §7b line 253-254). A lane that changes a protected gate file needs a `claude` review or owner instruction. If land-guard's merge command doesn't check this, it could allow a merge that violates §7b. Granted, this plan's own lane doesn't touch protected gate files, but land-guard is described as a general-purpose merge guard.

- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:23` — A change to a protected gate file (`scripts/collab/protected-gate-files.json`) never
merges on the agent's accept alone: it needs a `claude` review on the current head or an owner instruction that
names the plan; log each such file in `decisions.md`.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:246` — - the lane is `verified` and the review entry (§3) is `Collab-Verdict: accept` from
  `agent:vitana-lane-reviewer (<model>)` (`<model>` in its chain) on the PR's current head;
- every required check is green, incl. **Lane scope** and **Collab handoff**;
- the PR is up to date with latest `main` and its checks were re-run on that head (serialized landing, §8a); no
  conflict;
- every `depends_on` lane is `done`;
- the PR targets `main` and its deploy path is **staging only** (`AWS-STAGE-DEPLOY-*` and preview workflows);
- no protected gate file (§3a) is changed without a legacy `claude` review on the current head or the owner's
  instruction.

Suggestion: Either add a protected-gate-file check to the `merge` command (read the diff, match against the globs in `protected-gate-files.json`, and refuse if any match without a claude review trailer), or explicitly document that this check is deferred and the merge command does not cover that §7b clause.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
