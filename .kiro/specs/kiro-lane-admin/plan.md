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

## Measured state (origin/main, 2026-10-29, `scripts/collab/queue.mjs`)
- `PERM = ['executor', 'seat', 'reviewer_seat', 'paths']` (`scopeCheck`, :679). A change to any of these in a lane PR
  is refused (:683-684) unless `trustedFm.executor === 'claude'` AND every session that edited the lane file is a
  `session_…` id (`claudeOnly`, :682). The trusted revision is the merge-base, else a qualifying open `plan(` PR, else
  the other repo's main (`trustedFm`/`trustedFrom`, :671-677). When allowed, the PERM fields are taken from the trusted
  revision (:686); when refused, they are still pinned to trusted so the rest of the check uses the honest values.
- Governance-path carve-out already present (VTID-05276): a changed governance file passes for
  `fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && trustedFrom` (:701). A protected gate file never
  passes for a non-claude lane, whatever its reviewer (:699).
- Seat ownership (:711-715): a build commit whose session seat `!== fm.seat` of the lane it edits is refused
  (`edits lane … which belongs to seat …`). `fm` here is already pinned to the trusted PERM values, so a lane PR
  cannot dodge this by rewriting `seat` in its own head.
- `validateLane` (:around 190): a `kiro` lane whose declared `paths` reach a governance path needs
  `reviewer_seat: agent:vitana-lane-reviewer`; one that reaches a protected gate file needs `executor: claude`.
- Mirror: `services/gateway/src/services/project-manager/governance.ts` holds `PROTECTED_GATE_GLOBS`,
  `GOVERNANCE_PATHS`, the agent-accept / legacy-claude rule. `isLegacyClaudeReview` and the protected-gate unlock
  still require a legacy `claude` review. It does NOT model the PERM-change rule (that lives only in `scopeCheck`), so
  the mirror change here is confined to the protected-gate authority wording/behaviour, not the lane-admin path.
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
`reviewer_seat` is `agent:vitana-lane-reviewer`, whose declared `paths` include the target lane file(s)
(`.kiro/specs/<slug>/lanes/<id>.md`) it is authorized to administer. Such a lane — and only such a lane — may change
the PERM fields (`executor`, `seat`, `reviewer_seat`, `paths`) of a target lane, when the target lane's permissions it
is changing FROM come from a trusted source (`trustedFrom` set: merge-base, a qualifying `plan(` PR, or the other
repo's main — exactly the sources VTID-05276 already trusts). This is the direct analogue of the governance-path
carve-out: reviewer-agent review replaces the retired Claude-Code review, and the change must originate from trusted
state, never be self-granted in the lane PR head.

Preserved, by construction:
- **Seat ownership.** A lane-admin lane never lets an arbitrary session edit an arbitrary seat's lane. Three gates
  hold together: (1) the lane-admin lane has its own `seat`, and its build commits must come from that seat (existing
  seat-ownership check on the admin lane itself); (2) the admin lane is reviewer-agent-gated, so the builder never
  accepts it; (3) a lane-admin change is recognised only when the admin lane's own permissions are trusted — a PR
  cannot promote an ordinary lane to `lane_admin: true` in its own head and then use that to rewrite a foreign seat,
  because the trusted (base/plan-PR/main) revision of that lane is not `lane_admin`. The target lane's existing
  seat-ownership check is unchanged; what becomes legitimate is the documented, reviewed REASSIGNMENT of `seat`, not a
  silent cross-seat edit.
- **Scope checks.** The admin lane's own `paths` still bound every file it changes (it must list each target lane file
  it administers); the target lane's narrowed `paths` are still enforced on the target lane's own PRs. Narrow paths
  stay narrow.
- **Independent review.** `lane_admin: true` requires `reviewer_seat: agent:vitana-lane-reviewer` and `executor: kiro`
  (validated); the builder of the admin lane never reviews it.
- **Protected gate files stay owner-gated.** A lane-admin lane is NOT a protected-gate unlock. Protected gate files
  continue to need the owner instruction on the current head (the retired "legacy claude review" option is removed, not
  loosened). A `lane_admin` lane that itself changes a protected gate file is refused exactly like any other kiro lane.

## Changes (2 lanes)
1. `enforcement` (platform) — the single enforcement point, its tests, the JSON + builtin, and the PM mirror's
   protected-gate authority. Files:
   - `scripts/collab/queue.mjs`:
     - `validateLane`: accept `lane_admin` (boolean marker); a `lane_admin: true` lane must be `executor: kiro` with
       `reviewer_seat: agent:vitana-lane-reviewer` and must declare at least one target lane-file path
       (`.kiro/specs/*/lanes/*.md`); refuse `lane_admin: true` on any other shape. `lane_admin` is NOT a permission
       field (it is itself trusted-source-pinned via the existing PERM logic? — no: see design §2; it is added to the
       trusted-pinned set so a PR cannot self-grant it).
     - `scopeCheck`: add `laneAdmin = trustedFm.executor === 'kiro' && isReviewerAgent(trustedFm.reviewer_seat) &&
       trustedFm.lane_admin === true && !!trustedFrom`, computed from the TRUSTED revision of the lane that performs
       the change. The PERM-change allow condition (:683,:686) becomes
       `(trustedFm.executor === 'claude' && claudeOnly) || laneAdmin`. When `laneAdmin`, a PERM change to the target
       lane file(s) the admin lane declares is permitted and NOT pinned back to trusted; the refusal message is
       reworded to name the lane-admin path as the Kiro alternative. Pin `lane_admin` itself to the trusted revision
       so it can never be self-granted in the lane PR head.
     - Seat-ownership check (:711-715): unchanged in substance; it keeps refusing a cross-seat edit of a lane whose
       trusted `seat` differs — a reassignment is the admin lane editing the target lane file and is governed by the
       `laneAdmin` branch above, which is what makes the new `seat` legitimate. Add a test proving an ordinary lane PR
       still cannot rewrite another seat's lane.
     - Protected-gate behaviour unchanged (still refused for every non-claude lane); only the human-facing refusal and
       the authority wording stop citing Claude.
   - `scripts/collab/queue.test.mjs`: new cases, each red on origin/main first — (a) a `lane_admin: true` reviewer-
     agent lane from a trusted source reassigns a target lane's `seat` and narrows its `paths`: passes; (b) the same
     change from an ordinary (non-`lane_admin`) kiro lane: still refused; (c) a lane PR that self-grants
     `lane_admin: true` in its own head: refused (trusted revision is not lane_admin); (d) a `lane_admin` lane that
     touches a protected gate file: still refused; (e) seat-ownership still refuses a foreign-seat edit outside the
     admin path; plus `validateLane` cases for the new marker. Every refusal that held on origin/main still holds.
   - `scripts/collab/protected-gate-files.json` `description`: replace "needs a legacy claude review on the current
     head or the owner's instruction" with "needs the owner's instruction naming the plan plus a reviewer-agent accept
     on the current head (Claude Code is retired)". `PROTECTED_GATE_BUILTIN` content unchanged (globs identical); keep
     JSON `globs` ↔ builtin byte-identical (the existing parity assertion stays green).
   - `services/gateway/src/services/project-manager/governance.ts`: the protected-gate unlock replaces the legacy
     `claude` review with the owner-instruction-backed reviewer-agent accept, consistent with the rule text. Keep the
     agent-accept + head-currency logic. Update the file header prose that says "needs a legacy `claude` review".
     Gateway Jest for `governance.ts` stays green (update its tests in the same lane).
2. `rules` (platform, governance path — `reviewer_seat: agent:vitana-lane-reviewer`) — human-facing rule text,
   consistently, Claude-free:
   - `.claude/rules/collaboration.md` §3a and §7b: the protected-gate authority becomes "the owner's instruction
     naming the plan plus a reviewer-agent accept on the current head"; §7/§7a gain one sentence that an authorized
     reviewed lane-administration lane (`lane_admin: true`, `reviewer_seat: agent:vitana-lane-reviewer`) may reassign a
     lane's `seat` and narrow its `paths`, preserving seat ownership, scope and independent review.
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
