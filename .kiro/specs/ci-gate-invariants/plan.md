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
Sparring note: sessions `d288c7fe-940d-4452-9baa-884ce42f7178` and `ae4c9ffa-a5c7-43f6-8d15-0ef68cbb0e8b` (see
`sparring/state.json`) both escalated with `evidence_floor_not_met` (0 premise checks). This re-plan (owner instruction:
"Re-run PLAN-SPAR once more, with each premise cited as file:line. If it fails again, park it.") cites every premise at the
pinned SHAs below. Each citation was read with `git show <sha>:<path> | sed -n 'NNp'`. The quoted lines are in
`evidence.md`. The goal, the lanes and the VTIDs are unchanged. Corrections found during the re-check are marked **(corrected)**.
Premises with no citation were removed; they are listed under "Removed".

## Goal
Owner instruction, quoted verbatim: "Bundle the open lanes (#5050, #5068, #5070) into one plan PR, run it through the
machine sparring, and merge it on convergence under the bridge rule."

Scope, decided by Kiro after the premises were checked (Decision 1): this plan carries one lane, `bootstrap-pack-rules`
(PR #5070). Lanes `loop-catalog` (#5050) and `plan-sparring-wording` (#5068) are not in the bundle, because their changes
are either already on `main` or not needed for a green `main`. The owner decides what happens to those two PRs.

## Pinned SHAs
- `exafyltd/vitana-platform` origin/main: `4c4694b7977bbbff1610f1558ac91baeaf7a472b`
- `exafyltd/vitana-v1` origin/main: `447e46a82ea9e5dded5dc56b1876dfcde105e361` (**corrected**: the earlier pin `17a32ed80…`
  is superseded). No premise below cites a vitana-v1 file.

## Measured state
Every premise is read at the vitana-platform pin (`git show <sha>:<path>`), cited as `vitana-platform:<path>:<line>`.
Each citation names the file it depends on, after "depends on". Where a fact is a GitHub PR or commit state, the source is
given as `gh api` and is not a file at the pin.

## Today
- **#5050 is already on `main`.** `vitana-platform:services/gateway/specs/loop-catalog-v1.json:381` lists `"AWS-KIRO-ACCESS",`.
  The catalog is loaded by `vitana-platform:services/gateway/src/services/loop-catalog.ts:93` (depends on the JSON file) and is the
  catalog under test in `vitana-platform:services/gateway/test/loop-catalog.test.ts:2`. Commit `575d70e9ae` (subject
  `VTID-05785 (bridge-drift-fix/fix)`, one parent, an ancestor of the pin) introduced the string (`git log -S`).
  **(corrected: it is a single commit, not a merge commit.)** PR #5050 is **closed** (`gh api repos/exafyltd/vitana-platform/pulls/5050`,
  head `cee6b6fc18c4`). Its file list is empty (`pulls/5050/files` returns 0). Its commit `fa534e37` carries
  `Collab-Lane: ci-gate-invariants/loop-catalog`, which this plan keeps as the lane key.

- **#5068 is not needed for a green `main`.** `vitana-platform:services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts:45`
  pins `[Pp]lan → sparring → machine approval[\s\S]*?→ VTID → code\.`. The test reads `CLAUDE.md` at `:29`
  (depends on `vitana-platform:CLAUDE.md`). That pattern matches `vitana-platform:CLAUDE.md:336`
  ("plan → sparring → machine approval on convergence …"). PR #5068 is **closed** (`gh api repos/exafyltd/vitana-platform/pulls/5068`).
  Its only change to that test is on line 45, which it changes to `machine approval on convergence` (`pulls/5068/files`, patch).
  It would only tighten an existing assertion.

- **#5070 is the only change not on `main`.** `vitana-platform:services/gateway/src/services/operator-bootstrap-pack.ts:114-117`
  (`extractClaudeMdPart1`) cuts from the file start to `# PART 2` (`:115-116`). The budget is `LIMITS.rulesChars = 12_000` at
  `:59` (the VTID-05785 comment is at `:55`). The function is called at `:367` (depends on the function). The PR's patch
  (`gh api repos/exafyltd/vitana-platform/pulls/5070/files`) starts the slice at `text.indexOf('# PART 1')` and keeps the
  `# PART 2` cut and the budget.

- **What #5070 removes from the operator's pack.** `vitana-platform:CLAUDE.md:19` opens the "AUTONOMY CONTRACT" section, and
  `:75` opens the collaboration section. Both sit before `# PART 1` at `vitana-platform:CLAUDE.md:93`. `# PART 2` is at
  `vitana-platform:CLAUDE.md:513`. Today the pack carries lines 1–512, because the cut at `operator-bootstrap-pack.ts:115`
  finds `CLAUDE.md:513`. After #5070 it carries lines 93–512 only. This is an owner-visible change to the operator's
  orientation text, and sparring must rule on it (Risk 1).

- **The existing test still passes with the change.** `vitana-platform:services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts:41-46`
  asserts that the rules contain `# PART 1: CORE RULES` (`:42`), do not contain `# PART 2` (`:43`) or `## CHANGE LOG` (`:44`),
  are at most 12,020 characters (`:45`), and that a missing marker clips at the budget (`:46`). The test reads the real
  `CLAUDE.md` through `REAL_CLAUDE_MD` (`:21`, depends on `vitana-platform:CLAUDE.md`). None of these assertions depends
  on the preamble. The `:46` case returns the file start when the marker is missing, as it does now.

- **Trailers.** The PR #5070 commit `43ace0d89552a37100dd264ef0b5531708f6b23a` has no `Collab-` trailer (`gh api
  repos/exafyltd/vitana-platform/commits/43ace0d8…`). **(corrected)** The PR head is `8d1faca3c10d9f7f669b22fdb31d60fd8041abdb`,
  which is the third of three PR commits (`pulls/5070/commits`). It has no `Collab-` trailer either. The PR branch is
  `kiro/vtid-05792-bootstrap-pack-rules` (`pulls/5070`, head ref). The lane's commits in this plan carry the trailers. Kiro
  does not rewrite or invent trailers on #5070.

- **VTID.** VTID-05792 is the value the owner gave. `git grep -n VTID-05792` returns nothing at the platform pin
  (`vitana-platform:` tree) and at the vitana-v1 pin. Kiro did not check the ledger, and does not allocate it.

## Decisions taken
1. **Scope of the bundle.** The owner named three PRs. Kiro carries only #5070 in this plan. #5050 is already on `main`
   (see Today). #5068 is not needed for green and only tightens an existing test assertion (`test:45`). **(corrected)**
   Both #5050 and #5068 are already closed (`gh api`). This plan takes no action on them.
2. **Implementation.** The lane builds the change #5070 proposes (start at `# PART 1`, keep the `# PART 2` cut and the
   budget). It does this as a new implementation with its own test. It does not reuse the PR's commit, because that
   commit has no trailers (Today, Trailers).
3. **Tests.** The lane adds one new test file. It edits no existing test, and no test key changes. This is a Kiro decision,
   not a rule quoted from another document.
4. **VTID in the lane file.** `vitana-platform:.claude/rules/collaboration.md:53` lists the `vtid:` key as required from
   `executing` on. The lane is `ready`, so its frontmatter carries no `vtid:` key. VTID-05792 is named in the lane body, and
   CI writes the key on convergence. If the owner wants the key typed by hand, that is a separate decision.
5. **Path scope.** The lane's path is `docs/validation/VTID-05792/**`. #5070 already adds these files under that path
   (`pulls/5070/files`: `acceptance.md`, `commands.log`, `outputs/jest-vtid-04018.txt`, `scope.json`,
   `staging-tests.json`).
6. **Staging proof.** The gateway change is off by default: `vitana-platform:services/gateway/src/services/operator-bootstrap-pack.ts:73`
   returns true only when `OPERATOR_BOOTSTRAP_PACK_ENABLED === 'true'`. A staging probe of the operator bootstrap therefore needs
   the flag. The lane's proof is its unit tests, and it records the flag state in `docs/validation/VTID-05792/evidence.md`.
   Sparring may ask for a staging probe instead.

## Lanes
| Lane | VTID (owner-named) | Source PR | Repo | Paths |
|---|---|---|---|---|
| `bootstrap-pack-rules` | VTID-05792 | #5070 | vitana-platform | `services/gateway/src/services/operator-bootstrap-pack.ts`, `services/gateway/test/vtid-05792-bootstrap-pack-rules.test.ts` (new), `docs/validation/VTID-05792/**` |

`depends_on: []`. No other lane. No file is shared with another lane.

## Tests and commands
- New test file first. Its cases fail on `origin/main` (recorded red in the lane log) and pass after the change.
- `cd services/gateway && npx jest test/vtid-04018-operator-bootstrap-pack.test.ts test/vtid-05792-bootstrap-pack-rules.test.ts`
  (`vitana-platform:services/gateway/package.json:13` defines `"test": "jest"`; jest is a dev dependency at `:98`).
- `node scripts/collab/preflight.mjs` on the lane PR before every push (`vitana-platform:scripts/collab/preflight.mjs:1` is on `main`).

## Measurement
`docs/validation/<VTID>/timings.json` is written at Gate 2 (`vitana-platform:.kiro/pipeline/common-rules.md:71`, rule 12).

## Risks
1. **The operator loses the Autonomy Contract text.** After the change the pack starts at `vitana-platform:CLAUDE.md:93`, so the
   contract (`CLAUDE.md:19`, through the line before `:75`) and the lines between them are no longer in the pack. This is the
   intended effect of #5070, but sparring must confirm that the operator does not need that text. If sparring rejects the
   removal, the lane parks with the reason.
2. **Marker lookup.** `text.indexOf('# PART 1')` takes the first match. At the pin, `vitana-platform:CLAUDE.md` has one `# PART 1`
   (line 93, the only match in the file), so the first match is the header. The new test pins this on the real file.
3. **Staging evidence.** Staging cannot exercise the pack without the flag (Decision 6, `operator-bootstrap-pack.ts:73`).

## Out of scope and owner-gated
- PR #5069 and VTID-05793 (draft, HELD): `gh api repos/exafyltd/vitana-platform/pulls/5069` gives `draft: true`, head
  `524430dde66c`. Its owner-held migration `supabase/migrations/20261112110000_vtid_05793_definer_revoke_sparring_gate.sql:2`
  exists on that head and not on `main` (`git cat-file` on the pin fails). Not in this bundle, not touched.
- PRs #5050 and #5068: **closed** already (**corrected**, the earlier text said "left open"). This plan takes no action on them.
- Protected gate files: `vitana-platform:scripts/collab/protected-gate-files.json:5-18` lists the globs. It includes
  `CLAUDE.md` (`:5`), and `scripts/collab/queue.mjs` and `.github/workflows/PLAN-SPAR.yml` (`:7`, `:11`, the other entries). **(corrected)**
  The earlier text listed `scripts/collab/**`, `.kiro/steering/**` and `.claude/**`, which are not all in that list. This plan
  changes none of the listed globs, and the lane paths match none of them.
- Migrations, production, deploys, live systems: none.
- Merge: not part of this plan's step. The merge is a separate check, under `vitana-platform:.claude/rules/collaboration.md:257` (§7b).

## Removed (no citation possible at the pin)
- "VTID-05785 widened the same line and a lane review rejected the widening." Not citable at the pin. The `VTID-05785`
  commit changes the same test file (`575d70e9ae`, 14 lines), but the review outcome is not in the repo.
- "PLANWRITE-BRIEF forbids editing existing tests" and "the brief's example path." The brief is not in the repo. The
  two rules that remain are Decisions 3 and 5, which are Kiro's own decisions.
<!-- plan:end -->

Unchanged: the program entry is the only change outside this folder (`vitana-platform:docs/programs/native-app/program.md:8`
on the plan branch head `0380fe72da`; it is not at the pin).
