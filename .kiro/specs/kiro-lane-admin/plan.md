---
change_class: standard
---
# Plan — kiro-lane-admin

Author: Kiro, session `kiro-jtadic-202610291040-a0e6`, seat `jtadic`. Repo: `exafyltd/vitana-platform` (the single
enforcement point and all rule text live here; no `vitana-v1` code change — the byte-identical rule files are mirrored
in the text lane). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder.

<!-- plan:begin -->
## Goal
Owner decision, this conversation (2026-10-29, Kiro Web, seat `jtadic`): *"Update the obsolete Claude-only governance
rule so authorized Kiro sessions can perform lane administration through a reviewed, auditable process. Update the
relevant steering, documentation and enforcement consistently. Preserve seat ownership, scope checks and independent
review."* and *"Claude Code is retired — do not route this or future governance changes to Claude."*

Today one lane permission change — notably reassigning a lane's `seat` or adding/narrowing its `paths` — can only be
made by a Claude Code session (`session_…`) on an `executor: claude` lane. Claude Code is retired, so that rule is
unreachable: no authorized actor can legitimately reassign a lane. This plan adds a **reviewed, auditable Kiro
lane-administration path** that mirrors the existing VTID-05276 governance-path carve-out, while keeping every
safeguard, and it replaces the dead "legacy claude review" option on protected gate files with the owner instruction
that already backed it. Nothing becomes less protected than today.

This is the **first** of two sequential pieces the owner authorized. It lands on its own, before the feature lane
VTID-05207 (say-hello-composer) is re-validated, so that lane is reassigned to seat `jtadic` with accurate narrow
`paths` through the very mechanism this plan creates, and validated against the updated base revision. The feature
implementation is already done and is NOT touched here.

## Owner authority recorded for the merge step (CLAUDE.md §3a / collaboration.md §7b)
This plan edits protected gate files (`scripts/collab/queue.mjs`, `scripts/collab/protected-gate-files.json`,
`services/gateway/src/services/project-manager/governance.ts`, `CLAUDE.md`). Per §3a a protected gate file never merges
on a reviewer-agent accept alone. With Claude Code retired, the surviving authority is **the owner's explicit
instruction naming the plan plus a reviewer-agent accept on the current head**. The owner's authorization quoted under
"Goal" above IS that instruction for this plan (`kiro-lane-admin`). The merge of these lanes is performed by the
orchestrator / Project Manager citing this owner instruction, recorded in the lane log with `owner-instruction:` (the
owner's words + date) and `merge: <sha>`; a reviewer-agent accept alone never unlocks it.

## Measured state (branch head `c3ca9f601b` = origin/main @ d729406d4c, 2026-10-29, `scripts/collab/queue.mjs`)
- `PERM = ['executor', 'seat', 'reviewer_seat', 'paths']` (`scopeCheck`, :679). A change to any of these in a lane PR
  is refused (:684) unless `trustedFm.executor === 'claude'` AND every session that edited the lane file is a
  `session_…` id (`claudeOnly`, :682). The trusted revision is the merge-base, else a qualifying open `plan(` PR, else
  the other repo's main (`trustedFm`/`trustedFrom`, :664-670). When allowed, the PERM fields are taken from the trusted
  revision (:686); when refused, they are still pinned to trusted so the rest of the check uses the honest values.
- **Collab handoff cross-lane-file check (`validateRange`, :528).** Its section-2 loop classifies every changed file
  (`classifyPath` at :575) and continues only when the commit's `Collab-Lane` equals the file's own key (:584); a
  mismatch is refused at :591. A lane-admin PR edits a TARGET lane file whose key differs from the admin lane's own
  `Collab-Lane`, so without a new exemption every lane-admin PR fails Collab handoff (round-1 R1-F1, blocker).
  `validateRange` (:528) destructures only `fetchLane`, and its `validate` CLI site (:967-968) passes only `fetchLane`
  — NO `fetchPlanLane`, unlike `scopeCheck` (:628) and its `scope-check` CLI site (:989-997). So the shared
  `laneAdminCovers` helper cannot reach the plan-PR link of the trusted-source chain inside `validateRange`, an
  asymmetry between the two checks (round-2 R2-F2, major; fixed by threading `fetchPlanLane`).
- **Front-matter parsing (`parseFrontMatter`, :149-173).** Every scalar is assigned as a STRING (`out[kv[1]] =
  clean(v)` at :167; `clean` returns a `String` at :171-174). So `lane_admin: true` parses to the string `'true'`, and
  any `=== true` comparison on it is always false (round-2 R2-F1, blocker; fixed by a `toBool` helper). No existing
  parsed front-matter field is compared with `=== true` in `queue.mjs`.
- Governance-path carve-out already present (VTID-05276): a changed governance file passes for
  `fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && trustedFrom` (:702). A protected gate file never
  passes for a non-claude lane, whatever its reviewer (:699).
- Seat ownership (:714-715): a build commit whose session seat `!== fm.seat` of the lane it edits is refused
  (`edits lane … which belongs to seat …`). `fm` here is already pinned to the trusted PERM values, so a lane PR
  cannot dodge this by rewriting `seat` in its own head.
- `validateLane` (:206): a `kiro` lane whose declared `paths` reach a governance path needs
  `reviewer_seat: agent:vitana-lane-reviewer`; one that reaches a protected gate file needs `executor: claude`
  (the `fm.executor === 'kiro'` block at :232-235, `globTouchesProtected` push at :233).
- Mirror: `services/gateway/src/services/project-manager/governance.ts` holds the protected-gate / governance-path
  rule. `governanceMergeAllowed` (:184) returns `{ok:true}` for a protected gate file only when
  `isLegacyClaudeReview(review)` on the current head (:186-188); `queue.mjs` scope-check (:699) refuses protected gate
  files independently — two independent defense-in-depth layers (round-1 R1-F3). It does NOT model the PERM-change
  rule (that lives only in `scopeCheck`), so the mirror change here is confined to the protected-gate authority
  wording/behaviour, not the lane-admin path.
- `scripts/collab/protected-gate-files.json` `description` and `PROTECTED_GATE_BUILTIN` (queue.mjs) both say a
  protected gate file "needs a legacy claude review on the current head or the owner's instruction." The JSON `globs`
  and the builtin list are byte-identical in content and must stay so.
- Rule text repeating the dead "legacy claude review": `.claude/rules/collaboration.md` §3a (:131-132), §7b (:253),
  `CLAUDE.md` (:82-83, both repos byte-identical), `.kiro/pipeline/common-rules.md` rule 4 (:23-24),
  `.kiro/steering/vitana-owner-autonomy.md` stop #3 (:42), `vitana-v1/CLAUDE.md` (:107-108).
- Dormant overlap: the approved-but-unbuilt `retire-claude-code` plan (VTID-05255-05259) holds a `_plan` claim and has
  a `scope-rules` lane on the same file, but its design uses a *different, superseded* model (a `governance: true`
  boolean and a "different Kiro seat" review, measured against pre-VTID-05276 line numbers). All its lanes are still
  `ready`, there is no driver heartbeat and no open PR. This plan does NOT fold into it and does NOT touch its spec; it
  builds on the model that is actually on `main` today (VTID-05276 reviewer agent). The relationship is called out for
  sparring so the two are not merged blindly; if the owner later revives `retire-claude-code`, its `scope-rules` lane
  is reconciled with whatever this plan has already landed. Interface boundary: the two never edit the same file in an
  overlapping window because `retire-claude-code` is dormant and unclaimed-for-build.

## The new capability (minimal, auditable, reviewer-agent-gated)
A **lane-administration lane**: an `executor: kiro` lane carrying a new marker `lane_admin: true`, whose
`reviewer_seat` is `agent:vitana-lane-reviewer`, whose declared `paths` include the TARGET lane file(s)
(`.kiro/specs/<slug>/lanes/<id>.md`) it is authorized to administer. Such a lane — and only such a lane — may change
the PERM fields (`executor`, `seat`, `reviewer_seat`, `paths`) of a **target** lane it administers, when the target
lane's permissions it is changing FROM come from a trusted source (`trustedFrom` set: merge-base, a qualifying `plan(`
PR, or the other repo's main — exactly the sources VTID-05276 already trusts). This is the direct analogue of the
governance-path carve-out: reviewer-agent review replaces the retired Claude-Code review, and the change must originate
from trusted state, never be self-granted in the lane PR head.

**Target-only — the admin lane can never self-widen (round-1 R1-F2).** The carve-out applies ONLY to a target lane
file the admin lane administers, never to the admin lane's own PERM fields. The admin lane's own
`paths`/`executor`/`seat`/`reviewer_seat` (and `lane_admin` itself) stay trusted-pinned exactly as today — a PR that
tries to widen the admin lane's own `paths` or flip its own `executor`/`reviewer_seat` is refused and those fields are
pinned back to trusted. So an admin lane cannot widen itself and then reach further; 'narrow paths stay narrow' is
literally true for the admin lane too (design §2).

**Collab handoff exemption (round-1 R1-F1).** Because the admin lane edits a target lane file whose key differs from
its own `Collab-Lane`, `validateRange`'s cross-lane-file check (:591) would refuse it. A new, narrow exemption in that
loop (design §1a) lets the edit pass — but only when the committing admin lane's TRUSTED front matter has
`lane_admin: true` + `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer` AND the changed target lane file is
within that trusted admin lane's `paths`. Read from the trusted revision, so it cannot be self-granted in the PR head;
shares one helper with the scopeCheck carve-out.

Preserved, by construction:
- **Seat ownership.** A lane-admin lane never lets an arbitrary session edit an arbitrary seat's lane. Three gates
  hold together: (1) the lane-admin lane has its own `seat`, and its build commits must come from that seat (existing
  seat-ownership check on the admin lane itself); (2) the admin lane is reviewer-agent-gated, so the builder never
  accepts it; (3) a lane-admin change is recognised only when the admin lane's own permissions are trusted — a PR
  cannot promote an ordinary lane to `lane_admin: true` in its own head and then use that to rewrite a foreign seat,
  because the trusted (base/plan-PR/main) revision of that lane is not `lane_admin`. The target lane's existing
  seat-ownership check is unchanged; what becomes legitimate is the documented, reviewed REASSIGNMENT of a target
  lane's `seat`, not a silent cross-seat edit.
- **Scope checks.** The admin lane's own `paths` still bound every file it changes (it must list each target lane file
  it administers) and can never be widened by its own PR; the target lane's narrowed `paths` are still enforced on the
  target lane's own PRs. Narrow paths stay narrow.
- **Independent review.** `lane_admin: true` requires `reviewer_seat: agent:vitana-lane-reviewer` and `executor: kiro`
  (validated); the builder of the admin lane never reviews it.
- **Protected gate files stay owner-gated.** A lane-admin lane is NOT a protected-gate unlock. Protected gate files
  continue to need the owner instruction on the current head (the retired "legacy claude review" option is removed, not
  loosened). A `lane_admin` lane that itself changes a protected gate file is refused exactly like any other kiro lane.

## Changes (2 lanes)
1. `enforcement` (platform) — the single enforcement point, its tests, the JSON + builtin, and the PM mirror's
   protected-gate authority. Files:
   - `scripts/collab/queue.mjs`:
     - **`toBool` helper (R2-F1).** `parseFrontMatter` (:149-173) assigns every scalar as a STRING, so
       `lane_admin: true` parses to `'true'` and `=== true` is always false (dead on arrival). Add a module-level
       `const toBool = (v) => v === true || v === 'true';` next to `asList` and use `toBool(...)` EVERYWHERE
       `lane_admin` is tested (the `validateLane` marker, `selfTrustedLaneAdmin` in `scopeCheck`, the trusted predicate
       in `laneAdminCovers`); never boolean strict equality. There is no existing `=== true` on parsed front matter to
       be consistent with. (design §0)
     - `validateLane` (:206): accept `lane_admin` (string marker); a lane with `toBool(fm.lane_admin)` must be
       `executor: kiro` with `reviewer_seat: agent:vitana-lane-reviewer` and must declare at least one target lane-file
       path (`.kiro/specs/*/lanes/*.md`); refuse `lane_admin: true` on any other shape. `lane_admin` is NOT a
       permission field; it is added to the trusted-pinned set in `scopeCheck` so a PR cannot self-grant it. The
       existing protected-gate / governance-path checks in `validateLane` (:232-235) are untouched. (design §1)
     - `validateRange` (:528) — **new cross-lane-file exemption (R1-F1) + `fetchPlanLane` threading (R2-F2).** Add
       `fetchPlanLane = null` to `validateRange`'s options and thread it from the `validate` CLI command exactly as
       `scope-check` does (:989-997: `--plan-repo` repeatable, else `$GITHUB_REPOSITORY`, else `--lane-repo`, mapped
       through `ghPlanLaneFetcher`). In the section-2 loop, before the :591 error, add: a changed lane file
       (`c.kind === 'lane'`) whose key differs from the commit's `Collab-Lane` passes when a shared helper
       `laneAdminCovers(repo, base, head, adminLaneKey, targetLaneFile, fetchPlanLane)` is true — i.e. the committing
       admin lane's TRUSTED front matter (merge-base / qualifying plan( PR via `fetchPlanLane` / other-repo main, never
       the head) has `toBool(lane_admin)` + `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer` and the
       target lane file matches that trusted admin lane's `paths`. Threading `fetchPlanLane` keeps the trusted-source
       chain SYMMETRIC between Collab handoff and Lane scope, so a new admin lane created inside a plan( PR is
       recognised by both. Otherwise the :591 refusal stands. (design §1a)
     - `scopeCheck` (:664-686) — **target-only PERM carve-out (R1-F2).** Compute
       `selfTrustedLaneAdmin = trustedFm.executor === 'kiro' && isReviewerAgent(trustedFm.reviewer_seat) &&
       toBool(trustedFm.lane_admin) && !!trustedFrom`, from the TRUSTED revision (R2-F1: `toBool`, not `=== true`). The
       PERM-change allow condition
       (:684,:686) becomes `(trustedFm.executor === 'claude' && claudeOnly) || (selfTrustedLaneAdmin &&
       changedFileIsAdministeredTarget(lanePath, trustedFm))` — the carve-out applies ONLY when the lane under check is
       a TARGET lane file the admin lane administers, never to the admin lane's own file. When not allowed, pin ALL of
       `['executor','seat','reviewer_seat','paths','lane_admin']` back to trusted (so the admin lane can never
       self-widen and `lane_admin` can never be self-granted). Reword the PERM and governance-path refusals to name the
       Kiro lane-admin / reviewer-agent route. (design §2)
     - Seat-ownership check (:714-715): unchanged in substance; it keeps refusing a cross-seat edit of a lane whose
       trusted `seat` differs — a reassignment is the admin lane editing the target lane file and is governed by the
       target-only PERM carve-out above, which is what makes the new `seat` legitimate. Add a test proving an ordinary
       lane PR still cannot rewrite another seat's lane. (design §3)
     - Protected-gate behaviour in `scopeCheck` (:699) unchanged (still refused for every non-claude lane); only the
       human-facing refusal and the authority wording stop citing Claude.
   - `scripts/collab/queue.test.mjs`: new cases T-A..T-K (design §7), each red on origin/main first — the
     `validateLane` marker cases; a trusted `lane_admin` lane reassigning a TARGET lane's `seat`/`paths` passes (T-B);
     the same from an ordinary lane refused (T-C); a self-granted `lane_admin: true` in the head refused (T-D); a
     `lane_admin` lane touching a protected gate file refused (T-E); seat-ownership still refuses a foreign-seat edit
     (T-F); **the `validateRange` cross-lane-file exemption passes for a trusted admin lane (T-G) and an ordinary
     cross-lane-file edit is still refused (T-H)**; **a trusted `lane_admin` lane that tries to widen/change its OWN
     PERM fields or `lane_admin` is refused (T-I, the self-widen guard)**; **a `lane_admin: true` lane (parsed as the
     string `'true'`) is recognised and unlocks the carve-outs, and reverting any comparison to `=== true` fails the
     test (T-J, R2-F1)**; **the `validateRange` exemption resolves a trusted admin lane via `fetchPlanLane` from a
     qualifying plan( PR (T-K, R2-F2)**. Every refusal that held on origin/main still holds; all 53 existing cases +
     the JSON↔builtin parity assertion stay green.
   - `scripts/collab/protected-gate-files.json` `description`: replace "needs a legacy claude review on the current
     head or the owner's instruction" with "needs the owner's instruction naming the plan plus a reviewer-agent accept
     on the current head (Claude Code is retired)". `PROTECTED_GATE_BUILTIN` content unchanged (globs identical); keep
     JSON `globs` ↔ builtin byte-identical (the existing parity assertion stays green).
   - `services/gateway/src/services/project-manager/governance.ts` (:184) — **PM always refuses protected gate files
     (R1-F3).** `governanceMergeAllowed` ALWAYS returns `{ ok: false, reason: 'protected_gate_file' }` when
     `touchesProtectedGate(files)` — the legacy-claude programmatic unlock is RETIRED, not transferred to an
     agent-accept. The owner's instruction naming the plan is the out-of-band human authority recorded in the lane log
     (collaboration.md §7b), never a code-level unlock the PM can forge. This keeps BOTH independent layers (queue.mjs
     scope-check AND governance.ts) refusing protected gate files, so a `--admin` override of Lane scope is still
     caught by the PM — defense-in-depth preserved, nothing less protected than today. Remove the dead
     `isLegacyClaudeReview` protected-gate branch (delete `isLegacyClaudeReview` only if it has no other caller). Every
     other verdict (non-protected governance path with an agent accept on the current head, stale head, non-governance)
     is unchanged. Update the file header prose that says "needs a legacy `claude` review". Gateway Jest for
     `governance.ts` updated in the same lane (incl. a protected-gate PR with an agent accept → `protected_gate_file`)
     and green. (design §5)
2. `rules` (platform, governance path — `reviewer_seat: agent:vitana-lane-reviewer`) — human-facing rule text,
   consistently, Claude-free:
   - `.claude/rules/collaboration.md` §3a and §7b: the protected-gate authority becomes "the owner's instruction
     naming the plan plus a reviewer-agent accept on the current head"; §7/§7a gain one sentence that an authorized
     reviewed lane-administration lane (`lane_admin: true`, `reviewer_seat: agent:vitana-lane-reviewer`) may reassign a
     TARGET lane's `seat` and narrow its `paths`, preserving seat ownership, scope and independent review, and never
     widening the admin lane's own `paths`.
   - `.kiro/steering/vitana-collaboration.md` is the generated twin and stays a `#[[file:]]` link to the above — no
     edit needed; the workspace mirror `vitana-platform--vitana-*.md` is regenerated by
     `scripts/collab/kiro-web-steering.mjs` (not committed rule source). Confirm the steering guard
     `scripts/ci/kiro-steering/guard.cjs` stays green.
   - `CLAUDE.md` (platform) :82-83 and `vitana-v1/CLAUDE.md` :107-108 — byte-identical change in both repos: the
     protected-gate sentence drops "legacy Claude review" for the owner-instruction + reviewer-agent-accept wording.
     (CLAUDE.md is itself a protected gate file → owner-instruction-gated merge, see "Owner authority" above.)
   - `.kiro/pipeline/common-rules.md` rule 4 :23-24 and `.kiro/steering/vitana-owner-autonomy.md` stop #3 :42 — same
     reword.
   NOTE on repo split: the `vitana-v1/CLAUDE.md` edit is byte-identical to the platform change but lives in the other
   repo. Because `gh` cannot open cross-repo here and the enforcement is platform-centric, this lane's platform PR
   makes the platform edits; the one-line `vitana-v1/CLAUDE.md` mirror is carried in a sibling vitana-v1 PR of the same
   lane (collaboration.md §7: a lane may span both repos). The two edits are verified byte-identical by sha256 in the
   PR body, as the existing collaboration.md cross-repo rule requires.

Order: `enforcement` first (it must be on `main` so Lane scope fetches the new rule); then `rules`. `rules` depends on
`enforcement`. `scripts/collab/queue.mjs` and `CLAUDE.md` are hot files — the two lanes are sequenced, never parallel.

## Bootstrap
Today's Lane scope (fetched from main) refuses a governance path from a kiro lane unless `reviewer_seat:
agent:vitana-lane-reviewer` — both lanes already set that, so Collab handoff / Lane scope should be green by the
current (VTID-05276) rule, NOT red-by-construction. The one true gate is §3a: both lanes change protected gate files,
so each merges only on the owner instruction naming this plan (recorded above) plus a reviewer-agent accept on the
current head. No `--admin` override is expected; if a check is red it must be a known governance-artifact false
positive, logged with its run URL, never a real red test.

## Tests
- `enforcement`: `node --test scripts/collab/queue.test.mjs` green (new cases + all 53 existing); the new cases proven
  red on origin/main (negative control, captured in the PR body); gateway Jest for `governance.ts` green; the JSON ↔
  builtin parity assertion green.
- `rules`: `node scripts/collab/queue.mjs validate` green; `scripts/ci/kiro-steering/guard.cjs` green; the platform and
  vitana-v1 `CLAUDE.md` protected-gate sentences byte-identical (sha256 in the PR body); `collaboration.md` text
  consistent with the enforcement.
- No migration (scripts + docs + rules only). No staging/production data touched; no test targets production.

## Risks
- Separation of duties for a lane reassignment now rests on the reviewer agent + the admin lane's own seat ownership +
  trusted-source pinning of `lane_admin`, not on a second human agent. Mirrors the VTID-05276 governance-path trust
  model the owner already accepted; the builder still never accepts its own admin lane.
- Protected gate files are the stricter case and are deliberately left owner-instruction-gated — the lane-admin path
  never unlocks them.
- Overlap with the dormant `retire-claude-code` plan is called out above; sparring confirms the two models are
  reconciled, not stacked.
<!-- plan:end -->
