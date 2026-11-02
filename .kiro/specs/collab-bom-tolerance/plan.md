---
change_class: standard
---
# plan(collab-bom-tolerance): the collab validator reads lane and handoff files that start with a UTF-8 BOM
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611012315-0b54` (Kiro IDE, workflow `wf_d226722607ecc20f`,
owner backlog-cleanup task 2026-10-28). Premises pinned to vitana-platform `origin/main` `c90b993fce`. Detail:
`tasks.md`; lane file under `lanes/`.
**Protected gate file.** `scripts/collab/queue.mjs` is listed in `scripts/collab/protected-gate-files.json`. Under
`collaboration.md` §3a neither this plan PR nor the lane PR merges on a reviewer-agent accept alone: each needs the
owner's instruction naming `collab-bom-tolerance` plus a reviewer-agent accept on the current head.
<!-- plan:begin -->
## Goal
Owner task (backlog cleanup, 2026-10-28): finish the open records PRs. Platform records PRs #4568-#4572 (append-only
log entries for `desktop-spotlight-finish` lanes) fail Collab handoff with `no front matter` on lane files they do not
change. Make the validator read a file that starts with a UTF-8 BOM, without changing anything else it checks.
## Today (evidence, read-only)
1. `scripts/collab/queue.mjs:152-153`: `parseFrontMatter` runs `/^---\r?\n([\s\S]*?)\r?\n---/` on
   `String(text || '')` and returns `null` when it does not match. `validatePlan` (`:197`) and `validateLane`
   (`:215`) turn `null` into `no front matter`.
2. `validateRange` (`:787-797`) validates every handoff/lane file present at head for each touched slug, so an
   unchanged sibling lane file is validated too. `showFile` and `catFileBatch` decode blobs with
   UTF-8 (`showFile` `:486` through `git()` `encoding: 'utf8'` `:445`; `catFileBatch` `:476`; `commitFileReader`
   `:745`), which keeps a leading BOM as U+FEFF, so the anchor `^---` fails.
3. A scan of every `.kiro/specs/**/{handoff,lanes/*}.md` blob on `origin/main` finds a BOM in exactly eight files, all
   in `desktop-spotlight-finish/lanes/`: `colours-backoffice`, `colours-batch-2`..`-5`, `commerce-shell`, `sizes`,
   `skeletons`. They landed with commit `fd689346dc` (2026-10-21, `Collab-Lane: desktop-spotlight-finish/_plan`).
4. The same scan finds exactly one spec with lane files and no `handoff.md` on `main`: `desktop-spotlight-finish`.
   Its lane files reached `main` through three `_plan` commits (`fd689346dc`, `59f3b8352b`, `d466903efa`) so that
   vitana-v1 Lane scope could read their `paths`; its plan PR #4158 was closed unmerged, and its `handoff.md` exists only
   on branch `kiro/desktop-spotlight-finish/plan` (`323aa867fb`). No other plan on `main` was ever treated as exempt
   from `lanes without a handoff.md` (`:797`).
5. Existing test `queue.test.mjs:28-32` covers scalars, lists, comments and the no-front-matter case; nothing covers a
   BOM.
## Premises to check (each is one file read on `origin/main`)
- P1 `scripts/collab/queue.mjs` lines 151-171: `parseFrontMatter` and its `^---` regex on `String(text || '')`.
- P2 `scripts/collab/queue.mjs` lines 195-216: `validatePlan` / `validateLane` return `['no front matter']` on `null`.
- P3 `scripts/collab/queue.mjs` lines 786-797: `validateRange` validates every spec file at head for a touched slug and
  pushes `lanes without a handoff.md`.
- P4 `scripts/collab/queue.mjs` lines 238-241: `validateLane` refuses an `executor: kiro` lane whose `paths` reach a
  protected gate file.
- P5 `scripts/collab/protected-gate-files.json`: lists `scripts/collab/queue.mjs`.
- P6 `.kiro/specs/desktop-spotlight-finish/lanes/colours-backoffice.md`: first bytes `EF BB BF 2D 2D 2D`; no
  `.kiro/specs/desktop-spotlight-finish/handoff.md` exists.
- P7 `.kiro/specs/kiro-lane-admin/lanes/enforcement.md`: the precedent lane with protected paths in its body, not in
  `paths:`.
- P8 `scripts/collab/queue.test.mjs` lines 28-32: the existing `parseFrontMatter` test.
## Change (lane `bom-strip`, vitana-platform)
1. `scripts/collab/queue.mjs` `parseFrontMatter`: before the match, remove one leading U+FEFF from the input string
   (`String(text || '').replace(/^\uFEFF/, '')`). The regex, the key/list parsing and the return shape stay
   byte-identical. Nothing else in the file changes.
2. `scripts/collab/queue.test.mjs`, one new `node:test` case next to `:28`:
   - `parseFrontMatter('\uFEFF---\nlane: a\nstate: ready\n---\nbody')` deep-equals the result for the same text without
     the BOM (`{ lane: 'a', state: 'ready' }`). **Red on `origin/main`** (returns `null`), green on head.
   - the non-BOM text still parses to the same object (green on both).
   - `parseFrontMatter('no front matter')` and `parseFrontMatter('\uFEFFno front matter')` are both `null` (green on
     both).
## Decision: the missing `desktop-spotlight-finish/handoff.md`
The conservative option is chosen: the `lanes without a handoff.md` check stays exactly as it is, for every plan.
`desktop-spotlight-finish` gets its `handoff.md` in a separate `_plan` PR authored by that plan's driver (the session
holding its `_plan` lane, `kiro-202610152203-0347`, or the exceptions seat if that session is gone), not in this
plan. Reasons: no other plan on `main` has lanes without a handoff (premise 4), so a scoped exemption would exist for
one plan only and would weaken the check that keeps lanes tied to an approved plan; the file already exists on the
plan branch. Until that `_plan` PR lands, the records PRs #4568-#4572 stay red on that one error even after this fix.
## Lanes
- `bom-strip` (vitana-platform, `executor: kiro`, seat `exafy` from `docs/programs/areas.yaml` area `platform`,
  `reviewer_seat: agent:vitana-lane-reviewer`): changes 1-2 and `docs/validation/<VTID>/**`. `depends_on: []`. Its
  paths are listed in the lane body, not in `paths:`, because `validateLane` (`:238-241`) refuses an `executor: kiro`
  lane that declares a protected gate file (precedent: `kiro-lane-admin/lanes/enforcement.md` on `main`).
## Out of scope
- Stripping the BOMs from the eight lane files (they belong to `desktop-spotlight-finish`; its driver may do it in the
  same `_plan` PR).
- Other `^---` matchers: `frontMatterChanged`/`FRONT_MATTER_RE` (`queue.mjs:751-775`), the reference validator
  (`queue.test.mjs:1703-1708`), `plan-spar.mjs:196` `setFrontMatter`, `kiro-web-steering.mjs:30`. They do not produce
  the failing error; changing them is not needed for #4568-#4572.
- Any change to `validatePlan`, `validateLane`, `validateRange` or the handoff requirement.
## Test plan
- Lane: `node --test scripts/collab/queue.test.mjs` fails on `origin/main` only on the BOM assertion and passes in full
  on the lane head; outputs in `docs/validation/<VTID>/red-on-base.txt` and `commands.log`.
- `node scripts/collab/queue.mjs validate --base origin/main --head HEAD` exits 0 on the lane head.
- `node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD` exits 0 on the lane head; its output
  (including the `declares no paths … the Project Manager never merges it` warning, `queue.mjs:992`) goes to
  `commands.log` as evidence for the §3a merge path.
- No deploy: the change is CI tooling only, so there is no staging suite and no Gate 2.
## Merge (§3a protected gate file)
Neither this plan PR nor the `bom-strip` lane PR merges through the Project Manager: `governanceMergeAllowed`
(`services/gateway/src/services/project-manager/governance.ts:185`) always refuses `protected_gate_file` for
`scripts/collab/queue.mjs`. Each merges only when (1) the owner's instruction naming `collab-bom-tolerance` is recorded
in the lane log (or the handoff log, for the plan PR), (2) the reviewer agent `vitana-lane-reviewer` has accepted the
current head, and (3) every required check is green on that head. Never on a reviewer-agent accept alone, never
`--admin`. The change is done when the lane PR is merged that way with green checks.
<!-- plan:end -->
