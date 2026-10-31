# Design — kiro-lane-admin

All enforcement lives in `scripts/collab/queue.mjs` (plus the PM mirror `governance.ts`). Line numbers are the branch
head `c3ca9f601b` (= origin/main @ d729406d4c + the PLAN-SPAR round commit, which does not touch these files), 2026-10-29.

Round-1 sparring changed three things in this design: a new cross-lane-file exemption in `validateRange` (§1a, R1-F1),
the PERM carve-out is **target-lane-only and never applies to the admin lane's own fields** (§2, R1-F2), and the PM
**always refuses** protected gate files in code — the legacy-claude unlock is retired, not transferred to an agent
accept (§5, R1-F3). Line numbers corrected throughout (R1-F4).

Round-2 sparring changed two more: `lane_admin` is parsed as a **string**, so every test of it uses a `toBool` helper,
never boolean strict equality (§1/§1a/§2, R2-F1); and `fetchPlanLane` is threaded into `validateRange` so
`laneAdminCovers` resolves the same trusted-source chain as `scopeCheck` (§1a, R2-F2).

## §0 `toBool` helper (R2-F1)
`parseFrontMatter` (:149-173) assigns every scalar as a **string** (`out[kv[1]] = clean(v)` at :167; `clean` returns a
`String`). So `lane_admin: true` in front matter parses to the string `'true'`, and `trustedFm.lane_admin === true`
(strict boolean equality) is ALWAYS false — the whole mechanism would be dead on arrival. There is no existing
`=== true` comparison on any parsed front-matter field in `queue.mjs` to be consistent with; booleans today are gated
by presence (`!!trustedFrom`) or string equality (`fm.executor === 'kiro'`). Add one module-level helper next to
`asList`:
```js
const toBool = (v) => v === true || v === 'true';
```
and use `toBool(...)` EVERYWHERE `lane_admin` is tested — §1 (`validateLane` marker), §2 (`selfTrustedLaneAdmin` in
`scopeCheck`), and §1a (the trusted predicate inside `laneAdminCovers`). It accepts the boolean form too, so it stays
correct if `parseFrontMatter` is ever hardened to emit real booleans. T-J pins it: a lane whose front matter carries
the literal `lane_admin: true` (parsed as `'true'`) is recognised AND unlocks the carve-outs, and the test fails if any
`lane_admin` comparison is reverted to `=== true`.

## §1 `validateLane` (:206) — the `lane_admin` marker
Add recognition of `lane_admin` (parsed as a string, default absent/false) on a lane file:
- When `toBool(fm.lane_admin)` (§0 — the string `'true'`, never boolean `=== true`): require
  `fm.executor === 'kiro'` AND `isReviewerAgent(fm.reviewer_seat)` (i.e. `agent:vitana-lane-reviewer`) AND at least one
  declared `paths` glob that targets a lane file (`.kiro/specs/*/lanes/*.md`). Otherwise push a clear error
  (`lane_admin: true needs executor: kiro, reviewer_seat: <agent>, and a lane-file path`).
- `lane_admin` is NOT added to `PERM`. It is pinned to the trusted revision alongside the PERM fields in `scopeCheck`
  (see §2) so a lane PR can never self-grant it. A non-`lane_admin` lane is unchanged.
- The existing protected-gate / governance-path checks in `validateLane` (the `fm.executor === 'kiro'` block at
  :232-235, `globTouchesProtected` push at :233) are unchanged: a `lane_admin` lane whose `paths` reach a protected
  gate file is still refused unless `executor: claude` — which it cannot be (`lane_admin` requires `executor: kiro`),
  so a lane-admin lane can never declare a protected-gate path. Everything `validateLane` refuses today it still refuses.

## §1a `validateRange` (:528) — cross-lane-file exemption for a lane-admin PR (R1-F1)
The Collab handoff check's section-2 loop classifies every changed file (`classifyPath` at :575) and, at :584,
`continue`s only when the commit's `Collab-Lane` trailer equals the changed file's own classified key; otherwise :591
emits `changes <f> but its Collab-Lane is "<lane>" (needs "<key>"…)`. A lane-admin PR's commits carry
`Collab-Lane: <admin-slug>/<admin-lane>` while editing `.kiro/specs/<target-slug>/lanes/<target>.md`, whose key is
`<target-slug>/<target>` — so today every lane-admin PR fails Collab handoff. None of the existing exemptions
(:585-590) apply.

Add ONE narrow exemption in that loop (after the existing `:584` continue and the `_plan`/PLAN-SPAR/review exemptions,
before the :591 error), gated identically to the scopeCheck carve-out:
```js
// A reviewed, trusted lane-admin lane may edit a target lane file it administers (kiro-lane-admin).
if (c.kind === 'lane' && k.lane && k.lane !== key && laneAdminCovers(repo, base, head, k.lane, f, fetchPlanLane)) continue;
```
`laneAdminCovers(repo, base, head, adminLaneKey, targetLaneFile, fetchPlanLane)` returns true only when ALL hold:
- `adminLaneKey` resolves to a lane file whose **trusted** front matter has `toBool(lane_admin)` (§0 — the string
  `'true'`, never boolean `=== true`), `executor === 'kiro'` and `isReviewerAgent(reviewer_seat)`;
- `targetLaneFile` matches one of that trusted admin lane's `paths` globs (`matchesAny`, same glob semantics).

**Trusted-source chain — symmetric with `scopeCheck` (R2-F2).** The helper resolves the admin lane's trusted front
matter through the **identical** chain `scopeCheck` uses (:664-670): the merge-base, else a qualifying open `plan(` PR
(`planLaneQualifies(fetchPlanLane(slug, path))`, :728), else the other repo's main (`fetchLane`) — never the PR head.
To reach the plan-PR link, `validateRange` must RECEIVE `fetchPlanLane`, which it does not today (:528 destructures only
`fetchLane`, and its `validate` CLI site :967-968 passes only `fetchLane`). So this design adds `fetchPlanLane = null`
to `validateRange`'s options and threads it from the `validate` CLI command exactly as `scope-check` does (:989-997):
build `planFetchers` from `--plan-repo` (repeatable), else `$GITHUB_REPOSITORY`, else `--lane-repo`, map each through
`ghPlanLaneFetcher`, collapse to one `fetchPlanLane`, pass it into `validateRange`, and from there into
`laneAdminCovers`. Without this, a brand-new admin lane whose file exists only in its qualifying `plan(` PR (not yet on
main or in the merge-base) would be recognised by Lane scope but NOT by Collab handoff — the asymmetry R2-F2 names.
Because the admin lane's qualifying front matter is read from the trusted revision, a PR cannot write `lane_admin: true`
into its own head to unlock the exemption. The helper is shared with §2 (one source of truth for "is this a trusted
lane-admin lane, and does it cover this target file"). Covered by T-G (passes), T-H (an ordinary cross-lane-file edit —
no trusted lane_admin — is still refused) and T-K (the plan-PR trusted-source path resolves through `fetchPlanLane`).

## §2 `scopeCheck` — the lane-administration carve-out for PERM changes (target-lane-only; R1-F2)
Current (:679-686):
```js
const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
const sessions = new Set(commits.filter((k) => k.files.includes(lanePath) && k.session !== PM_AGENT).map((k) => k.session));
const claudeOnly = sessions.size > 0 && [...sessions].every((x) => /^session_/.test(x));
if (changed.length && !(trustedFm.executor === 'claude' && claudeOnly)) { errors.push(`lane ${key}: ...`); }
if (!(trustedFm.executor === 'claude' && claudeOnly)) fm = { ...fm, ...Object.fromEntries(PERM.map((k) => [k, trustedFm[k]])) };
```
`scopeCheck` runs once per lane, keyed on the PR's single `Collab-Lane` (`key`). The lane under check (`lanePath`,
`trustedFm`) is EITHER the admin lane itself OR a target lane the admin lane administers — never both in one call,
because a PR names one lane. The carve-out must apply ONLY to the target case, never to the admin lane's own fields:

```js
// The lane under check is a TARGET only if some trusted lane_admin lane in THIS PR covers lanePath.
// `key` is the PR's own Collab-Lane; the admin lane is that same lane when it administers a target.
const targetOfAdmin = laneAdminCovers(repo, base, head, key, lanePath) && key !== `${slug}/${id}`
  ? false // defensive: key always equals slug/id here; see note
  : laneAdminCovers(repo, base, head, key, lanePath);
const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
const TRUSTED_PINNED = [...PERM, 'lane_admin'];
const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
const claudeOnly = /* unchanged */;
const permAllowed = (trustedFm.executor === 'claude' && claudeOnly) || targetOfAdmin;
if (changed.length && !permAllowed) { errors.push(`lane ${key}: ${changed.join(', ')} changed in a lane PR — lane
  permissions come from the base revision (reassign a target lane through an executor: kiro, reviewer_seat:
  agent:vitana-lane-reviewer lane with lane_admin: true from a trusted source whose paths cover it, or change an
  executor: claude Claude Code lane)`); }
if (!permAllowed) fm = { ...fm, ...Object.fromEntries(TRUSTED_PINNED.map((k) => [k, trustedFm[k]])) };
```
Note on `key` vs `lanePath`: in `scopeCheck`, `key` is the PR's single `Collab-Lane` and `lanePath =
.kiro/specs/<slug>/lanes/<id>.md` is that same lane's file (`key === slug/id`). So the lane being scope-checked IS the
lane the PR names. The admin lane edits the TARGET lane file directly: the PR's `Collab-Lane` is the admin lane, and
the file whose PERM fields change is the target lane file inside the admin lane's `paths`. Therefore the correct
predicate is: **`targetOfAdmin` is true when the admin lane (`key`) has trusted `lane_admin` and its trusted paths
cover `lanePath` for some OTHER target lane** — i.e. when `key` is a lane-admin lane editing a different lane's file.
The precise, non-defensive form used in code:
```js
const selfTrustedLaneAdmin = trustedFm.executor === 'kiro' && isReviewerAgent(trustedFm.reviewer_seat)
  && toBool(trustedFm.lane_admin) && !!trustedFrom;  // §0: toBool, never `=== true` (lane_admin parses as a string)
// A PERM change is carved out only for a TARGET lane file the admin lane covers, never for the admin lane's own file.
const targetLaneFilesChanged = /* lane files in the diff that are NOT `lanePath` and match trusted admin paths */;
const permAllowed = (trustedFm.executor === 'claude' && claudeOnly)
  || (selfTrustedLaneAdmin && changedFileIsAdministeredTarget(lanePath, trustedFm));
```
Because `scopeCheck` keys on one lane per PR and the PERM change lands on the TARGET lane's own file, the admin lane's
OWN front matter is never the subject of a carved-out PERM change: when `scopeCheck` is invoked for the admin lane's
own file, `changedFileIsAdministeredTarget(adminOwnFile, …)` is false (a lane never lists its own file as an
administered target distinct from itself), so `permAllowed` falls back to the old `claude && claudeOnly` and the admin
lane's own PERM fields stay trusted-pinned. **The admin lane can never self-widen.**

Key properties, each covered by a test:
- **Trusted-source only.** The lane-admin qualification reads `trustedFm`/trusted admin paths (merge-base / qualifying
  plan( PR / other-repo main), never the lane PR head `fm`. A PR that writes `lane_admin: true` into its own head does
  NOT qualify. `lane_admin` is re-pinned from `trustedFm` when `!permAllowed` (added to `TRUSTED_PINNED`) so a
  head-written `lane_admin: true` cannot leak into later checks. (T-D, T-I)
- **Target-only; the admin lane never self-widens.** The carve-out applies only to a target lane file the admin lane
  administers; the admin lane's own `paths`/`executor`/`seat`/`reviewer_seat`/`lane_admin` stay trusted-pinned exactly
  as today. 'Narrow paths stay narrow' is literally true for the admin lane. (T-I)
- **Reviewer-agent-gated.** Requires `isReviewerAgent(trustedFm.reviewer_seat)` and `executor: kiro`, which
  `validateLane` guarantees pairs with the agent and a lane-file path — the independent reviewer accepts the admin
  lane; the builder never does (existing §7 review rule, unchanged).
- **Protected gate files unaffected.** The PERM carve-out is about lane-file permission fields; the scopeCheck loop
  (:699) that refuses a protected gate file for any non-claude lane is unchanged — a `lane_admin` lane that changes a
  protected gate file is still refused. (T-E)

## §3 Seat ownership preserved (:714-715)
The seat-ownership check (:714-715) keys on `fm.seat`, where `fm` has already been pinned to trusted PERM values when
`!permAllowed`. Two cases:
- Ordinary lane PR trying to edit a foreign seat's lane: `permAllowed` is false, `fm.seat` stays the trusted seat, and
  the editing session's seat `!== fm.seat` → refused exactly as today. (Test: unchanged refusal, T-F.)
- A `lane_admin` lane legitimately reassigning a target lane's `seat`: the reassignment is the admin lane editing the
  TARGET lane file. The admin lane's own PR carries `Collab-Lane: <slug>/<admin-lane>`; the target lane file change is
  in-scope because the admin lane's `paths` list the target lane file (and the §1a validateRange exemption lets the
  cross-lane-file edit pass Collab handoff). The admin lane's own seat ownership (its build commits come from its
  `seat`) and reviewer-agent gating authorize the change; the target lane's NEW `seat` is the reviewed, audited
  reassignment outcome. The target lane's own future PRs are then owned by the new seat. No change to the
  seat-ownership check code is required; a test pins that an ordinary PR still cannot do this.

## §4 Refusal-message and authority wording (Claude removed)
- `scopeCheck` governance-path refusal (:702) and the PERM refusal (§2) mention the Kiro lane-admin / reviewer-agent
  path; they no longer imply Claude is the only route. (Claude Code strings already present for `executor: claude`
  legacy lanes stay, because such lanes still validate; they are not the primary path any more.)
- `scripts/collab/protected-gate-files.json` `description`: replace "needs a legacy claude review on the current head
  or the owner's instruction" with "needs the owner's instruction naming the plan plus a reviewer-agent accept on the
  current head (Claude Code is retired)". Globs unchanged.
- `PROTECTED_GATE_BUILTIN` in `queue.mjs`: globs unchanged (still byte-identical in content to the JSON `globs`); only
  the surrounding comment prose is updated to match.

## §5 PM mirror `governance.ts` — always refuse protected gate files (R1-F3)
Round-1 R1-F3: replacing the legacy-claude protected-gate unlock with an agent-accept would REMOVE the PM's
independent defense-in-depth. Today `governanceMergeAllowed` (:184) returns `{ok:true}` for a protected gate file only
when `isLegacyClaudeReview(review)` on the current head (:186-188); `queue.mjs` scope-check (:699) refuses them
independently. Decision (adopted from the partner): **the PM's programmatic unlock is retired entirely, not
transferred.**
- `governanceMergeAllowed` ALWAYS returns `{ ok: false, reason: 'protected_gate_file' }` when
  `touchesProtectedGate(files)` — no review (legacy-claude or agent) ever unlocks a protected gate file in code. The
  dead `isLegacyClaudeReview`-based unlock for protected gate files is removed; `isLegacyClaudeReview` itself may be
  deleted if it then has no other caller (confirm in the lane; otherwise leave it).
- The authority for a protected-gate merge is the **owner's instruction naming the plan**, recorded out-of-band in the
  lane log (`collaboration.md` §7b already treats "the owner's instruction" as merge authority) plus the reviewer-agent
  accept on the current head for the rest of the merge gate. The code never forges that authority from a review row.
- Both independent layers (queue.mjs scope-check AND governance.ts) continue to refuse protected gate files, so a
  `--admin` override of Lane scope is still caught by the PM. Nothing becomes less protected than today.
- Every OTHER `governanceMergeAllowed` verdict (non-protected governance path with an agent accept on the current head,
  stale head, non-governance) is unchanged.
- Gateway Jest tests for `governance.ts` updated in the same lane: a protected-gate PR with a reviewer-agent accept on
  the current head still yields `{ ok: false, reason: 'protected_gate_file' }`; the legacy-claude protected-gate path
  is gone; every non-protected case is unchanged.

## §6 Rule text (lane `rules`)
Consistent, Claude-free edits (see plan.md Changes 2 for the file list and line numbers). The substance in each:
protected gate file → "the owner's instruction naming the plan plus a reviewer-agent accept on the current head"; and
one sentence in collaboration.md §7/§7a that an authorized `lane_admin: true`, `reviewer_seat:
agent:vitana-lane-reviewer` lane may reassign a target lane's `seat` and narrow its `paths`, preserving seat ownership,
scope and independent review, and never widening its own paths. `vitana-collaboration.md` stays a `#[[file:]]` link (no
body edit).

## §7 Tests (red-on-base first)
`scripts/collab/queue.test.mjs` (node --test):
- T-A `validateLane`: `lane_admin: true` with `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer` + a
  lane-file path → []; the same without the agent / without kiro / without a lane-file path → error.
- T-B `scopeCheck`: a trusted `lane_admin` lane (from merge-base) reassigns a TARGET lane's `seat` and narrows its
  `paths` → []. (Red on base: today a PERM change by a non-claude session is refused.)
- T-C `scopeCheck`: the same PERM change from an ordinary (non-`lane_admin`) kiro lane → still refused.
- T-D `scopeCheck`: a PR that self-grants `lane_admin: true` in its own head (trusted revision not lane_admin) → the
  target PERM change is still refused (`lane_admin` pinned to trusted).
- T-E `scopeCheck`: a `lane_admin` lane that changes a protected gate file → still refused (`is a protected gate file`).
- T-F seat ownership: an ordinary lane PR editing a foreign seat's lane → still refused.
- T-G `validateRange`: a trusted `lane_admin` lane whose `paths` cover a target lane file, committing with
  `Collab-Lane: <admin-slug>/<admin-lane>`, edits that target lane file → Collab handoff passes (the cross-lane-file
  exemption, §1a). (Red on base: today the trailer mismatch is refused at :591.)
- T-H `validateRange`: an ordinary lane (no trusted `lane_admin`) edits another lane's file with a mismatched
  `Collab-Lane` → still refused.
- T-I `scopeCheck`: a trusted `lane_admin` lane that tries to widen/change its OWN `paths` / `executor` /
  `reviewer_seat` / `seat` / `lane_admin` in its PR head → refused; its own PERM fields are pinned back to trusted
  (self-widen is impossible, R1-F2).
- T-J `toBool` (R2-F1): a lane whose front matter carries the literal `lane_admin: true` (parsed by
  `parseFrontMatter` as the STRING `'true'`) is recognised as a lane-admin lane by `validateLane` and unlocks both the
  `scopeCheck` PERM carve-out and the `validateRange` cross-lane-file exemption. Written so that reverting any
  `lane_admin` comparison to boolean strict equality (`=== true`) leaves the string-`'true'` lane unrecognised and
  fails the assertion — the dead-on-arrival regression is caught. (Covers §0/§1/§1a/§2.)
- T-K `validateRange` plan-PR trusted source (R2-F2): a trusted `lane_admin` admin lane whose file is resolvable ONLY
  via `fetchPlanLane` (a qualifying open `plan(` PR — `planLaneQualifies` true, not on main or in the merge-base),
  committing with `Collab-Lane: <admin>/<admin-lane>` and editing a target lane file within its trusted `paths`, passes
  the §1a cross-lane-file exemption. Fails if `fetchPlanLane` is not threaded into `validateRange`/`laneAdminCovers`
  (proves the chain is symmetric with `scopeCheck`).
- Parity: JSON `globs` === builtin content (existing assertion) stays green.
All 53 existing tests stay green.
Gateway: `governance.ts` Jest suite updated and green, incl. the "protected gate file with an agent accept →
`protected_gate_file`" case (R1-F3).
