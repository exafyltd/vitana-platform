---
change_class: standard
---
# plan(remove-b12-claude-sparring-gate1): remove the Claude-Code local-sparring Gate 1 carve-out (B12)
<!-- plan:begin -->
## 1. Goal (owner, 2026-10-28, Kiro Web session kiro-jtadic-202610281355-d593)
> "OK, let's remove B12 step related to Claude Code, because we want Claude Code eliminated from the process anyway"

"B12" is row 12 of the Stops table in `.kiro/steering/vitana-owner-autonomy.md`: *"Gate 1, for a plan Claude Code
sparred with its own local partner. A CI-sparred plan that converged is approved by policy and never goes to the
owner."* The owner wants this carve-out removed entirely, so that **CI PLAN-SPAR policy approval
(`converged-auto-v1`) is the only plan-approval path** and no plan is ever routed to the owner on the basis of a
Claude-Code local-partner sparring session. After the change, the binding rule set (the Stops table, the CLAUDE.md
Autonomy Contract, CLAUDE.md rule 2b and §4.1, and `collaboration.md` §7) must all agree on that single path, with no
dangling reference to the removed carve-out.

This is a wording/consistency change to binding Markdown rule/steering files only. It changes no code, no workflow, no
schema; it deploys nothing. It does not loosen a stop: every other row of the Stops table, and every prohibition in
every rule file, is unchanged. It only deletes a question the owner no longer wants asked (and never a safeguard).

## 2. Today (read-only evidence, `origin/main` platform `ad6b081d`, vitana-v1 `1349f699`, 2026-10-28 ~14:00Z)
The carve-out appears in exactly these binding sites. All target files were re-read fresh on `origin/main`.

### 2.1 The Stops table (both repos, byte-identical; `diff` confirms identical)
- `vitana-platform/.kiro/steering/vitana-owner-autonomy.md:51` and `vitana-v1/.kiro/steering/vitana-owner-autonomy.md:51`
  — Stops table **row 12**: `| 12 | Gate 1, for a plan Claude Code sparred with its own local partner. A CI-sparred
  plan that converged is approved by policy and never goes to the owner. | CLAUDE.md Autonomy Contract;
  collaboration.md §7 | Claude Code local sparring only |`.
- The table has **13 rows** (1-13). Row 13 is product autonomy.
- `vitana-owner-autonomy.md:59-60` (both repos), in the "How to read the broad sentences" section, references the
  product-autonomy row by number **twice**: *"this covers the product's autonomy settings (**stop 13**) … it is not
  approval for **stop 13**."* These references track whatever number the product-autonomy row carries.

### 2.2 CLAUDE.md (platform only; protected gate file)
- `vitana-platform/CLAUDE.md:37-38` — Autonomy Contract, final sentence of the "Policy approval replaces Gate 1 for
  CI-sparred plans" paragraph: *"A plan Claude Code spars with its own local partner still goes to the owner as Gate
  1."*
- `vitana-platform/CLAUDE.md:102` — rule 2b: *"(rules 51–55): owner Gate 1 for a locally sparred plan, or CI policy
  `converged-auto-v1`."*
- `vitana-platform/CLAUDE.md:499` — §4.1 Allocation: *"(Part 1 rules 51–55): owner Gate 1 for a plan sparred with a
  local partner (skill `plan-sparring`), or CI policy `converged-auto-v1` for a `plan(` PR."*

### 2.3 collaboration.md §7 (both repos, byte-identical in this region; `diff` of lines 180-210 confirms identical)
- `.claude/rules/collaboration.md:185-186` (both repos) — Sparring bullet, final sentence: *"Claude Code may still
  spar its own plans with its local partner; the owner then answers Gate 1 as before."*
- `.claude/rules/collaboration.md:202` (both repos) — "The owner is asked only" bullet: *"Gate 2 (and Gate 1 for a
  plan Claude Code sparred locally), an escalated sparring verdict, and the stop cases …"*

### 2.4 Not binding / out of scope (confirmed by reading)
- `vitana-v1/CLAUDE.md` — its Autonomy Contract is **stale** vs platform: it has **no** "Policy approval replaces Gate
  1" paragraph and **no** local-partner carve-out (`grep` for `spars with its own` / `local partner` / `locally
  sparred` / `Policy approval replaces Gate 1` → no matches). There is nothing to remove there; syncing it would widen
  scope beyond the owner's instruction. Left unchanged.
- `docs/validation/**` and `.kiro/specs/**` (incl. operating-workflow, retire-claude-code, claude-sessions-handover):
  HISTORY per `.kiro/steering/vitana-load-project-rules.md` ("only rule text on `origin/main` is binding … records
  under `.kiro/specs/**` are history"). Not binding rule text. Left unchanged.
- `vitana-platform/scripts/collab/protected-gate-files.json` — confirms `CLAUDE.md` is a protected gate file; the
  steering/** and .claude/rules/** files here are **not** in that glob list (only `CLAUDE.md` among the targets is
  protected). So the CLAUDE.md change needs the protected-gate authority (§4); the other files merge on the
  reviewer-agent accept alone.

## 3. The exact replacement wording (inter-lane interface — both repos must end identical)
Both repos' copies of `collaboration.md` and `vitana-owner-autonomy.md` are byte-identical today and MUST stay
byte-identical after the change. The replacement text below is the contract both lanes implement verbatim.

### I1 — Stops table (`vitana-owner-autonomy.md`, both repos)
Delete row 12 in full. Renumber the former row 13 (product autonomy) to **12**, so the table is contiguous 1-12 with
no gap and no dangling reference. In the "How to read the broad sentences" section, change both occurrences of
`stop 13` to `stop 12` (same two sentences, only the number changes). No other line of the file changes.

Result: the table ends at row 12 (product autonomy), and the Stops list contains no Gate-1/Claude-local row.

### I2 — CLAUDE.md Autonomy Contract (`vitana-platform/CLAUDE.md:34-38`)
Delete the final sentence `A plan Claude Code spars with its own local partner still goes to the owner as Gate 1.`
The paragraph then reads (unchanged except the deletion):
> **Policy approval replaces Gate 1 for CI-sparred plans (owner decision 2026-10-14, VTID-05214/05218).** A plan
> sparred by `PLAN-SPAR.yml` whose session converged is approved by the policy `converged-auto-v1` (recorded on the
> sparring record and accepted by the `vtid_ledger` gate); it is not sent to the owner. A plan that does not converge
> after its re-plan session is parked on the Command Hub board, with no message.

### I3 — CLAUDE.md rule 2b (`vitana-platform/CLAUDE.md:102`)
Change `(rules 51–55): owner Gate 1 for a locally sparred plan, or CI policy ` + "`converged-auto-v1`" + `.` to:
`(rules 51–55): CI policy ` + "`converged-auto-v1`" + `.` so the locally-sparred-plan carve-out is gone; the rest
of the sentence (including the `(rules 51–55)` reference and the "A Kiro plan's VTIDs are allocated by CI PLAN-SPAR on
convergence, never by hand." that follows) is unchanged. (The colon introduces the path, so no leading "via" — the
same colon-introduces-the-path style as I4; R1-F1.)

### I4 — CLAUDE.md §4.1 (`vitana-platform/CLAUDE.md:499`)
Change `(Part 1 rules 51–55): owner Gate 1 for a plan sparred with a local partner (skill ` + "`plan-sparring`" +
`), or CI policy ` + "`converged-auto-v1`" + ` for a ` + "`plan(`" + ` PR.` to:
`(Part 1 rules 51–55): CI policy ` + "`converged-auto-v1`" + ` for a ` + "`plan(`" + ` PR.` The following sentence ("A
Kiro plan's lane VTIDs are allocated by CI PLAN-SPAR on convergence — Kiro never allocates by hand …") is unchanged.

### I5 — collaboration.md §7 Sparring bullet (`:185-186`, both repos)
Delete the final sentence `Claude Code may still spar its own plans with its local partner; the owner then answers
Gate 1 as before.` The bullet then ends: *"… Not converged after the re-plan session → `parked`, on the board, no
message."*

### I6 — collaboration.md §7 "The owner is asked only" bullet (`:202`, both repos)
Change `**The owner is asked only:** Gate 2 (and Gate 1 for a plan Claude Code sparred locally), an escalated
sparring verdict, and the stop cases …` to `**The owner is asked only:** Gate 2, an escalated sparring verdict, and
the stop cases …` (drop the parenthetical; the rest of the sentence unchanged).

## 4. Lanes
Three lanes. `CLAUDE.md` must be its **own** lane because it is a **protected gate file**: Lane scope / scope-check
(`scripts/collab/queue.mjs`) refuses a `CLAUDE.md` change from any lane that is not `executor: claude` ("a protected
gate file never passes for a non-claude lane, whatever its reviewer — an agent review cannot unlock it", `queue.mjs`
~:699, and the drafted-lane validator ~:233 rejects an `executor: kiro` lane whose `paths` reach a protected gate
file). The other two files (`collaboration.md`, `vitana-owner-autonomy.md`) are governance paths but **not** protected
gate files, so they build as `executor: kiro` with `reviewer_seat: agent:vitana-lane-reviewer`. No two lanes edit the
same file.

- **`platform-governance`** (repo `exafyltd/vitana-platform`, `executor: kiro`, seat `jtadic`,
  `reviewer_seat: agent:vitana-lane-reviewer`): applies I5, I6 to `.claude/rules/collaboration.md`; I1 to
  `.kiro/steering/vitana-owner-autonomy.md`. Paths: `.claude/rules/collaboration.md`,
  `.kiro/steering/vitana-owner-autonomy.md`, `docs/validation/VTID-*/**`.
- **`platform-claude-md`** (repo `exafyltd/vitana-platform`, **`executor: claude`**, seat `exafyltd` = the exceptions
  seat, `depends_on: [platform-governance]`): applies I2, I3, I4 to `CLAUDE.md` only. Paths: `CLAUDE.md`,
  `docs/validation/VTID-*/**`. **Merge authority (§6 R3): the owner's named-plan instruction this session** (recorded
  in the lane log + RUN `decisions.md`). When Claude Code is unavailable, the exceptions seat `exafyltd` builds it
  (§7 Claude-unavailable mode); the lane stays `executor: claude` so Lane scope passes the `CLAUDE.md` change.
- **`v1-governance`** (repo `exafyltd/vitana-v1`, `executor: kiro`, seat `jtadic`,
  `reviewer_seat: agent:vitana-lane-reviewer`, `depends_on: [platform-governance]`): applies I5, I6 to
  `.claude/rules/collaboration.md`; I1 to `.kiro/steering/vitana-owner-autonomy.md`. `depends_on` platform-governance
  so the v1 wording is copied from the merged platform wording (byte-identical guarantee). Paths:
  `.claude/rules/collaboration.md`, `.kiro/steering/vitana-owner-autonomy.md`, `docs/validation/VTID-*/**`. No
  CLAUDE.md edit in v1 (stale; nothing to remove).

### Parallel / shared / hot files
- Shared between lanes: none edit the same file (platform copies, the platform CLAUDE.md, and the v1 copies are all
  distinct paths). The *wording* is shared — defined by the interface §3, not by a front-matter key.
- Hot files sequenced, never parallel: `CLAUDE.md` (platform-claude-md only). `platform-claude-md` and `v1-governance`
  both `depends_on: [platform-governance]` so platform-governance lands first and sets the canonical wording.

## 5. Tests / commands (verification; this change has no unit test over prose)
Per lane, before every push and after the merges:
1. `node scripts/collab/preflight.mjs --repo <checkout> --base origin/main --head HEAD --branch <branch> --title "<title>"`
   (Collab tests, `queue.mjs validate`, Lane scope, PR-GATE checks, Kiro steering) — fix every error, re-run to green.
2. grep both repos, restricted to `CLAUDE.md`, `.claude/rules/collaboration.md`,
   `.kiro/steering/vitana-owner-autonomy.md`, for `local partner`, `locally sparred`, `sparred with its own`,
   `Gate 1 for a plan Claude Code`, `spar its own`, `sparred locally` → **zero matches**.
3. grep the Stops table for `B12` / standalone `row 12` / `stop 13` → none dangling; read the table to confirm
   contiguous numbering 1-12 and the two "How to read" references read `stop 12`.
4. `node vitana-platform/scripts/collab/kiro-web-steering.mjs --check` → `ok` after the merges are pulled into the
   checkouts (the generated workspace steering must regenerate cleanly from the edited sources).

## 6. Risks
- **R1 — Stops-table numbering.** Removing row 12 and renumbering 13→12 means the two `stop 13` references in the
  "How to read the broad sentences" section must become `stop 12` or they dangle. I1 handles this explicitly. The
  alternative (leave a gap at 12, keep row 13) would leave a dangling "row 12" concept and is rejected as less
  consistent. CI PLAN-SPAR adjudicates the choice.
- **R2 — cross-plan contention with `operating-workflow` (approved, lanes `ready`, NOT merged).** As of
  `origin/main` `ad6b081d`, every operating-workflow policy lane (`policy-text`, `policy-text-v1`, `policy-claude-md`,
  `policy-claude-md-v1`) is `ready` with its branch still `origin/main` — none merged. operating-workflow
  **relocates** these same files: it turns `vitana-owner-autonomy.md` into a one-line pointer and moves the Stops
  table into new files `.claude/rules/operating-policy.md` + `.kiro/steering/vitana-operating-policy.md`, and its
  `plan.md:128` preserves the table's "current 13 rows, UNCHANGED WORDING" — i.e. it does **not** remove B12, it moves
  the table that contains it. Contingency, to make the B12 removal land coherently regardless of merge order:
  - **If this plan's lanes build while `vitana-owner-autonomy.md` still holds the 13-row table on `origin/main`**
    (the state today): target the file as it stands (I1). This is the assumed case.
  - **If operating-workflow has relocated the table by the time a lane builds** (owner-autonomy.md is now a one-line
    pointer and the table lives in `operating-policy.md` / `vitana-operating-policy.md`): the lane must re-read
    `origin/main` at build time, apply I1 to the **new** location of the table (delete the Gate-1/Claude-local row,
    renumber, fix the `stop N` references wherever they now live), and leave the one-line pointer alone. The lane
    `paths` are widened only if that case is reached; otherwise they stay as in §4.
  - **If this plan merges first**, operating-workflow's "unchanged wording / 13 rows" claim for the table becomes
    stale by one row; its builders/sparring reconcile to the 12-row table (that is operating-workflow's problem to
    absorb at its build time, not a change this plan makes). Surfaced here so CI PLAN-SPAR, which checks premises
    against code, adjudicates the collision. This is contention between two of the owner's own authorized plans,
    resolved inside the pipeline by sparring + sequencing — not an owner stop.
- **R3 — `CLAUDE.md` is a protected gate file** (`scripts/collab/protected-gate-files.json`). Its lane PR does not
  merge on the reviewer-agent accept alone (§3a/§7b): it needs a legacy `claude` review on the current head **or the
  owner's instruction naming the plan**. The owner's instruction in this session ("remove B12 step related to Claude
  Code, because we want Claude Code eliminated from the process anyway") IS that named-plan authority. It is recorded
  in the `platform-claude-md` lane log and the RUN `decisions.md` as the §7b authority for the protected `CLAUDE.md`
  change. This is NOT an owner stop; it is authorized. Because `CLAUDE.md` is a protected gate file, its lane is
  `executor: claude` (Lane scope refuses a `CLAUDE.md` change from a non-claude lane, `queue.mjs` ~:699/:233); with
  Claude Code unavailable the exceptions seat `exafyltd` builds it (§7 Claude-unavailable mode).
- **R4 — adjacency (surfaced, not auto-fixed).** `vitana-platform/.kiro/hooks/vitana-pipeline-start.json` already says
  *"the only owner stop is Gate 2 (plus an escalated sparring verdict)"*, omitting Gate 1 entirely — i.e. it is
  already consistent with this change's direction. It is a hook prompt, not a Stops-table/rule-text site in scope. Not
  edited here; surfaced for sparring/owner to decide whether it wants any wording touch. (If sparring directs it in
  scope, it is a governance path, not a protected gate file.)
- **R5 — `retire-claude-code` (approved, lanes `ready`, not merged).** Its `rules-platform`/`rules-v1` lanes touch
  `CLAUDE.md` + `collaboration.md` to remove Claude Code broadly, but do NOT list `vitana-owner-autonomy.md` and do
  not target the B12 row specifically. Overlap is on `CLAUDE.md` + `collaboration.md` only; resolved by serialized
  landing (one merge per repo at a time, each lane brought up to date with latest `main` before merge) — same
  mechanism as R2.

## 7. Unchanged (explicit)
- Every other Stops-table row (1-11 and the former 13 / new 12). No stop is loosened or removed except the Gate-1
  Claude-local carve-out the owner named.
- The two-gate concept itself (Gate 1 / Gate 2) stays wherever it is the generic owner-approval concept; only the
  *Claude-Code-local-partner* path to Gate 1 is removed. CI policy `converged-auto-v1` is unchanged and remains the
  approval path.
- `vitana-v1/CLAUDE.md`, `docs/validation/**`, `.kiro/specs/**` history, `vitana-pipeline-start.json`,
  `protected-gate-files.json`, all code/workflows/schema: unchanged.
<!-- plan:end -->
