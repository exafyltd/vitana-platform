---
slug: ci-gate-invariants
change_class: standard
author: kiro
author_seat: exafyltd
---
# Plan — ci-gate-invariants

Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-platform` only. Spec: `handoff.md`, `tasks.md`, `lanes/*.md` in this
folder. The `vtid:` of each lane is written by CI after PLAN-SPAR converges, never by hand.

<!-- plan:begin -->
Sparring note (2026-11-13T12:00Z): session 1 escalated on round 1 with `evidence_floor_not_met` (0 premise checks), a partner-side failure; this line opens the re-plan session. No plan content changed.

## Goal
Owner instruction, quoted verbatim: "Bundle the open lanes (#5050, #5068, #5070) into one plan PR, run it through the
machine sparring, and merge it on convergence under the bridge rule."

Scope, decided by Kiro after the premises were checked (Decision 1): this plan carries one lane, `bootstrap-pack-rules`
(PR #5070). Lanes `loop-catalog` (#5050) and `plan-sparring-wording` (#5068) are not in the bundle, because their changes
are either already on `main` or not needed for a green `main`. The owner decides what happens to those two PRs.

## Measured state
Pinned: vitana-v1 origin/main 17a32ed80346ab8241d88cb2bfef34b01fdf7533, vitana-platform origin/main
4c4694b7977bbbff1610f1558ac91baeaf7a472b (2026-11-13T11:11Z).

Every premise is read at those SHAs (`git show <sha>:<path>`), cited as `vitana-platform:<path>:<line>`.

## Today
- **#5050 is already on `main`.** `vitana-platform:services/gateway/specs/loop-catalog-v1.json:381` lists
  `"AWS-KIRO-ACCESS"`. VTID-05785 (merge commit `575d70e9ae`, lane `bridge-drift-fix/fix`) added it. The PR's file
  list is empty against `main`, so the PR has nothing left to change. Its commit `fa534e37` carries the valid trailer
  `Collab-Lane: ci-gate-invariants/loop-catalog`, which this plan keeps as the lane key.
- **#5068 is not needed for a green `main`.** `vitana-platform:services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts:45`
  pins `[Pp]lan → sparring → machine approval[\s\S]*?→ VTID → code\.`. That pattern already matches
  `vitana-platform:CLAUDE.md:336` ("plan → sparring → machine approval on convergence …"). VTID-05785 widened the same
  line and a lane review rejected the widening. #5068 would only tighten an existing assertion, and PLANWRITE-BRIEF
  forbids editing existing tests.
- **#5070 is the only change not on `main`.** `vitana-platform:services/gateway/src/services/operator-bootstrap-pack.ts:114-117`
  (`extractClaudeMdPart1`) cuts from the file start to `# PART 2`. The change starts it at `# PART 1`. The budget stays at
  `LIMITS.rulesChars = 12_000` (`operator-bootstrap-pack.ts:59`, VTID-05785).
- **What #5070 removes from the operator's pack.** `vitana-platform:CLAUDE.md:19` opens the "AUTONOMY CONTRACT" section.
  `# PART 1` is at `CLAUDE.md:93`, and `# PART 2` at `CLAUDE.md:513`. Today the pack carries lines 1–512, including the
  Autonomy Contract. After #5070 it carries lines 93–512 only. This is an owner-visible change to the operator's
  orientation text, and sparring must rule on it (Risk 1).
- **The existing test still passes with the change.** `vitana-platform:services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts:41-46`
  asserts that the rules contain `# PART 1: CORE RULES`, do not contain `# PART 2`, are at most 12,020 characters, and
  that a missing marker clips at the budget. None of these depends on the preamble.
- **Trailers.** The PR #5070 commit `43ace0d89552a37100dd264ef0b5531708f6b23a` has no `Collab-Session` and no
  `Collab-Lane` trailer. The PR's branch is `kiro/vtid-05792-bootstrap-pack-rules`, not a `kiro/<slug>/<lane>` branch.
  The lane's commits in this plan carry the trailers. Kiro does not rewrite or invent trailers on #5070.
- **VTID.** VTID-05792 is the value the owner gave. It does not appear in `vitana-platform` or `vitana-v1` on `main`.
  Kiro did not check the ledger, and does not allocate it.

## Decisions taken
1. **Scope of the bundle.** The owner named three PRs. Kiro carries only #5070 in this plan. #5050 is already on `main`
   (see Today). #5068 is not needed for green and edits an existing test, which PLANWRITE-BRIEF forbids. Both PRs stay
   open. Closing them is the owner's action, and this plan does not take it.
2. **Implementation.** The lane builds the change #5070 proposes (start at `# PART 1`, keep the `# PART 2` cut and the
   budget). It does this as a new implementation with its own test. It does not reuse the PR's commit, because that
   commit has no trailers.
3. **Tests.** The lane adds one new test file. It edits no existing test, and no test key changes (PLANWRITE-BRIEF).
4. **VTID in the lane file.** The brief says a draft lane carries no `vtid:` key, and the owner asked for the VTID in
   the lane file. Kiro follows the brief. VTID-05792 is named in the lane body, and CI writes the `vtid:` key on
   convergence. If the owner wants the key typed by hand, that is a separate decision.
5. **Path scope.** The lane's `docs/validation/` path is `docs/validation/VTID-05792/**`, narrower than the brief's
   example. Other VTIDs' validation records are outside this lane.
6. **Staging proof.** The gateway change is off by default: `operator-bootstrap-pack.ts:73` returns true only when
   `OPERATOR_BOOTSTRAP_PACK_ENABLED === 'true'`. A staging probe of the operator bootstrap therefore needs the flag. The
   lane's proof is its unit tests, and it records the flag state in `docs/validation/VTID-05792/evidence.md`. Sparring
   may ask for a staging probe instead.

## Lanes
| Lane | VTID (owner-named) | Source PR | Repo | Paths |
|---|---|---|---|---|
| `bootstrap-pack-rules` | VTID-05792 | #5070 | vitana-platform | `services/gateway/src/services/operator-bootstrap-pack.ts`, `services/gateway/test/vtid-05792-bootstrap-pack-rules.test.ts` (new), `docs/validation/VTID-05792/**` |

`depends_on: []`. No other lane. No file is shared with another lane.

## Tests and commands
- New test file first. Its cases fail on `origin/main` (recorded red in the lane log) and pass after the change.
- `cd services/gateway && npx jest test/vtid-04018-operator-bootstrap-pack.test.ts test/vtid-05792-bootstrap-pack-rules.test.ts`
- `node scripts/collab/preflight.mjs` on the lane PR before every push.

## Measurement
`docs/validation/<VTID>/timings.json` is written at Gate 2 (`common-rules.md` rule 12).

## Risks
1. **The operator loses the Autonomy Contract text.** After the change the pack starts at `CLAUDE.md:93`, so the
   contract at `CLAUDE.md:19-92` is no longer in the pack. This is the intended effect of #5070, but sparring must
   confirm that the operator does not need that text. If sparring rejects the removal, the lane parks with the reason.
2. **Marker lookup.** `text.indexOf('# PART 1')` takes the first match. At the pin, `CLAUDE.md` has one `# PART 1`
   (line 93), so the first match is the header. The new test pins this on the real file.
3. **Staging evidence.** Staging cannot exercise the pack without the flag (Decision 6).

## Out of scope and owner-gated
- PR #5069 and VTID-05793 (draft, HELD): an owner-held migration (`supabase/migrations/20261112110000_vtid_05793_definer_revoke_sparring_gate.sql`).
  Not in this bundle, not touched.
- PRs #5050 and #5068: left open and unchanged. Closing them is an owner decision.
- Protected gate files (`CLAUDE.md`, `scripts/collab/**`, `.kiro/steering/**`, `.claude/**`): not changed.
- Migrations, production, deploys, live systems: none.
- Merge: not part of this plan's step. The merge is a separate check, under `collaboration.md` §7b.
<!-- plan:end -->

Unchanged: the program entry is the only change outside this folder (`docs/programs/native-app/program.md`).
