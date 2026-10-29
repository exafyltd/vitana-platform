# Design — kiro-lane-admin

All enforcement lives in `scripts/collab/queue.mjs`. Line numbers are origin/main @ d729406d4c (2026-10-29).

## §1 `validateLane` — the `lane_admin` marker
Add recognition of `lane_admin` (boolean, default absent/false) on a lane file:
- When `fm.lane_admin === true` (accept the string `true` the same way other booleans are parsed): require
  `fm.executor === 'kiro'` AND `isReviewerAgent(fm.reviewer_seat)` (i.e. `agent:vitana-lane-reviewer`) AND at least one
  declared `paths` glob that targets a lane file (`.kiro/specs/*/lanes/*.md`). Otherwise push a clear error
  (`lane_admin: true needs executor: kiro, reviewer_seat: <agent>, and a lane-file path`).
- `lane_admin` is NOT added to `PERM`. Instead it is pinned to the trusted revision in `scopeCheck` (see §2) so a lane
  PR can never self-grant it. A non-`lane_admin` lane is unchanged.
- Everything `validateLane` refuses today it still refuses (the new rule only adds a constraint on `lane_admin: true`).

## §2 `scopeCheck` — the lane-administration carve-out for PERM changes
Current (:679-686):
```js
const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
const sessions = new Set(commits.filter((k) => k.files.includes(lanePath) && k.session !== PM_AGENT).map((k) => k.session));
const claudeOnly = sessions.size > 0 && [...sessions].every((x) => /^session_/.test(x));
if (changed.length && !(trustedFm.executor === 'claude' && claudeOnly)) { errors.push(`lane ${key}: ...`); }
if (!(trustedFm.executor === 'claude' && claudeOnly)) fm = { ...fm, ...Object.fromEntries(PERM.map((k) => [k, trustedFm[k]])) };
```

Design change — add the lane-admin allowance, computed from the **trusted** revision of the lane being changed:
```js
const laneAdmin = trustedFm.executor === 'kiro' && isReviewerAgent(trustedFm.reviewer_seat)
  && trustedFm.lane_admin === true && !!trustedFrom;
const permAllowed = (trustedFm.executor === 'claude' && claudeOnly) || laneAdmin;
if (changed.length && !permAllowed) { errors.push(`lane ${key}: ${changed.join(', ')} changed in a lane PR — lane
  permissions come from the base revision (change them through an executor: kiro, reviewer_seat:
  agent:vitana-lane-reviewer lane with lane_admin: true from a trusted source, or on an executor: claude Claude Code
  lane)`); }
if (!permAllowed) fm = { ...fm, ...Object.fromEntries(PERM.map((k) => [k, trustedFm[k]])) };
```
Key properties, each covered by a test:
- **Trusted-source only.** `laneAdmin` reads `trustedFm` (merge-base / qualifying plan( PR / other repo main), never the
  lane PR head `fm`. A PR that writes `lane_admin: true` into its own head does NOT qualify (its trusted revision is
  not `lane_admin`), so `lane_admin` cannot be self-granted. (This is why `lane_admin` is pinned to trusted like a PERM
  field: when `!laneAdmin` we must not let a head-written `lane_admin: true` leak into later checks — add `lane_admin`
  to the set re-pinned from `trustedFm` when `!permAllowed`.)
- **Reviewer-agent-gated.** `laneAdmin` requires `isReviewerAgent(trustedFm.reviewer_seat)` and `executor: kiro`,
  which `validateLane` guarantees pairs with the agent and a lane-file path — the independent reviewer accepts the
  admin lane; the builder never does (existing §7 review rule, unchanged).
- **Protected gate files unaffected.** The PERM carve-out is about lane-file permission fields; the later loop
  (:697-702) that refuses a protected gate file for any non-claude lane is unchanged — a `lane_admin` lane that changes
  a protected gate file is still refused.

## §3 Seat ownership preserved
The seat-ownership check (:711-715) keys on `fm.seat`, where `fm` has already been pinned to trusted PERM values when
`!permAllowed`. Two cases:
- Ordinary lane PR trying to edit a foreign seat's lane: `permAllowed` is false, `fm.seat` stays the trusted seat, and
  the editing session's seat `!== fm.seat` → refused exactly as today. (Test: unchanged refusal.)
- A `lane_admin` lane legitimately reassigning a target lane's `seat`: the reassignment is the admin lane editing the
  TARGET lane file. The admin lane's own PR carries `Collab-Lane: <slug>/<admin-lane>`; the target lane file change is
  in-scope because the admin lane's `paths` list the target lane file (R3). The admin lane's own seat ownership (its
  build commits come from its `seat`) and reviewer-agent gating are what authorize the change. The target lane's NEW
  `seat` is the reassignment outcome, not a dodge: it is written from the admin lane, reviewed, audited. The target
  lane's own future PRs are then owned by the new seat. No change to the seat-ownership check code is required; a test
  pins that an ordinary PR still cannot do this.

## §4 Refusal-message and authority wording (Claude removed)
- `scopeCheck` governance-path refusal (:702) and the PERM refusal (§2) mention the Kiro lane-admin / reviewer-agent
  path; they no longer imply Claude is the only route. (Claude Code strings already present for `executor: claude`
  legacy lanes stay, because such lanes still validate; they are not the primary path any more.)
- `scripts/collab/protected-gate-files.json` `description`: replace "needs a legacy claude review on the current head
  or the owner's instruction" with "needs the owner's instruction naming the plan plus a reviewer-agent accept on the
  current head (Claude Code is retired)". Globs unchanged.
- `PROTECTED_GATE_BUILTIN` in `queue.mjs`: globs unchanged (still byte-identical in content to the JSON `globs`); only
  the surrounding comment prose is updated to match.

## §5 PM mirror `governance.ts`
- `isLegacyClaudeReview` / the protected-gate unlock: today a protected gate file is unlocked only by a legacy `claude`
  review on the current head. Replace with the owner-instruction-backed reviewer-agent accept: a protected gate file
  merges when the reviewer agent accepted on the current head AND the owner instruction is recorded for the PR — the
  code-level unlock becomes the agent accept on the current head (the owner instruction is the human authority recorded
  in the lane log / PR, exactly as §7b already treats "the owner's instruction"), and the dead legacy-claude branch is
  removed. Keep `governanceMergeAllowed` returning `protected_gate_file` when no qualifying accept exists. Update the
  file header prose that says "needs a legacy `claude` review on the current head or the owner's instruction" to the
  Claude-free wording.
- Gateway Jest tests for `governance.ts` updated in the same lane: a protected-gate PR with a reviewer-agent accept on
  the current head is allowed (owner instruction assumed by the harness as it is recorded out-of-band), the legacy
  `claude` path is gone, and every other case (governance path, stale head, non-protected) is unchanged.

## §6 Rule text (lane `rules`)
Consistent, Claude-free edits (see plan.md Changes 2 for the file list and line numbers). The substance in each:
protected gate file → "the owner's instruction naming the plan plus a reviewer-agent accept on the current head"; and
one sentence in collaboration.md §7/§7a that an authorized `lane_admin: true`, `reviewer_seat:
agent:vitana-lane-reviewer` lane may reassign a lane's `seat` and narrow its `paths`, preserving seat ownership, scope
and independent review. `vitana-collaboration.md` stays a `#[[file:]]` link (no body edit).

## §7 Tests (red-on-base first)
`scripts/collab/queue.test.mjs` (node --test):
- T-A `validateLane`: `lane_admin: true` with `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer` + a
  lane-file path → []; the same without the agent / without kiro / without a lane-file path → error.
- T-B `scopeCheck`: a trusted `lane_admin` lane (from merge-base) reassigns a target lane's `seat` and narrows its
  `paths` → []. (Red on base: today PERM change by a non-claude session is refused.)
- T-C `scopeCheck`: the same PERM change from an ordinary (non-`lane_admin`) kiro lane → still refused.
- T-D `scopeCheck`: a PR that self-grants `lane_admin: true` in its own head (trusted revision not lane_admin) → the
  PERM change is still refused.
- T-E `scopeCheck`: a `lane_admin` lane that changes a protected gate file → still refused (`is a protected gate file`).
- T-F seat ownership: an ordinary lane PR editing a foreign seat's lane → still refused.
- Parity: JSON `globs` === builtin content (existing assertion) stays green.
All 53 existing tests stay green.
Gateway: `governance.ts` Jest suite updated and green.
