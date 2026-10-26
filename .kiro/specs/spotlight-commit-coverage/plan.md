---
change_class: light
---
# plan(spotlight-commit-coverage): STAGING-VERIFY coverage for the 10 desktop-spotlight merges without a VTID
<!-- plan:begin -->
## Problem
STAGING-VERIFY for community-app fails under rule 47 even though every test passes. Run 39952660840 (vitana-v1
`f36cd6b63`, 2026-10-23) reports "Tests: 32/32 passed" and then lists 10 commits under "Missing change suite". Each
is a merge commit `Merge pull request #14xx from exafyltd/kiro/desktop-spotlight-finish/<lane>`, so its subject
carries no VTID. Gate 2 for VTID-05330, VTID-05332 and the other 21 commits in the range is blocked on this. The
owning session `kiro-202610152203-0347` last committed on 2026-10-22, and its plan is stuck at `sparring`.

**Owner approval (2026-10-26, Kiro Web session `kiro-exafyltd-202610220833-d231`):** "Yes, I approve". This answers the
question to approve `commit-coverage.json` entries for these 10 merges plus the 7 missing suites.

## Premises (read-only; `exafyltd/vitana-v1` @ `fb9b6d843602f504a9ebfd794d4156ccfcda431f`, pinned in `handoff.md` `spar_refs`)
1. `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:376-380` reads
   `docs/validation/commit-coverage.json` from `repoRoot`. The workflow passes `--repo-root target`, the vitana-v1
   checkout at the commit under test (`exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml:162-195`). So
   the file belongs in **vitana-v1**, which has none yet. vitana-platform has its own one, for gateway.
2. `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:278-340` (`parseCommitCoverage` / `planRange`):
   - an entry needs the full 40-hex `sha`, a `vtid`, a `reason` and `approved_by`;
   - only a commit with no VTID in its subject is covered;
   - the covering VTID's `docs/validation/<VTID>/staging-tests.json` must exist and pass `validateManifest`
     (`lib.cjs:211-221`), or that commit is still `missing`.
   An `existing` test must match `EXISTING_REF` (`lib.cjs:121-124`): `npm run <script>` or `npx vitest run <paths>`.
3. Each merge's branch commits name its lane VTID, and on vitana-v1 `fb9b6d843` **every one of the 10 VTIDs already
   has a valid suite**, `exafyltd/vitana-v1:docs/validation/VTID-0528{5..9},VTID-0529{0..4}/staging-tests.json` (Playwright
   staging specs `tests/e2e/staging/vtid-052xx-*.staging.spec.ts`). The suites exist; only the coverage mapping is
   missing.
4. The 10 merges (full sha → lane → VTID), from `git log --format=%B <sha>^1..<sha>`:
   `aa3fb55f204d689c957aa20f2b2d14dda9a19ada` skeletons 05294 · `624618db1bd9f874525b69eb90c16333184278f7` commerce-shell 05290 ·
   `b8a4efbd31b43001f65150e6316056cfcde18248` public-profile 05291 · `11b4e2ba2617b9d7541ca39c69d1b343696d84fd` remaining-screens 05292 ·
   `d8c29bc97afb7c4cdf65ad23869560ee1d7ae6d0` sizes 05293 · `141eeaa3808e1033eea72826b1c6c7813c144d04` colours-batch-3 05287 ·
   `5044c5d2960583272726d4d8cd9e8fc0ed0129d8` colours-backoffice 05285 · `8a49243c8c251fd4ab010cedf167495794714bee` colours-batch-4 05288 ·
   `b59597e0f876b9bc4dafd4fef326e84ba879896e` colours-batch-5 05289 · `77cb11280d9ba8e8f0063282b512fdc5e030c9e3` colours-batch-2 05286.
5. Tests each merge added (`git diff --name-only <sha>^1 <sha>`):
   - backoffice: `src/components/backoffice/{ApprovalDecisionDialog,DraftCommandDialog,PolicyEditDialog}.colours.test.tsx`;
   - batch-2: `src/components/calendar/vcal/typography.test.ts`, `src/components/journey/GuidedJourneyCatalog.test.tsx`,
     `src/lib/vitana-index-next-steps.test.ts`;
   - remaining-screens: `src/components/tickets/remaining-screens.spotlight.test.tsx`, `src/design/screen-manifest.test.ts`;
   - sizes: `src/design/eslint-design-rules.test.ts`, `src/design/screen-manifest.test.ts`;
   - batches 3, 4 and 5: no test, only `scripts/ci/pr-gate/baseline/design.json` / `eslint.json` ratchet updates.
     Their guard is the design contract (`package.json` `test:design-contract`).

6. PLAN-SPAR itself was down 2026-10-22 → 2026-10-26 (`PLAN-SPAR.yml:122` used `secrets.` in a step `if:`). It was
   repaired by #4351, merged as `exafyltd/vitana-platform` `55cc5bbadc1925eaf57aa3e6600bbcf3766062ab` on the owner's
   instruction of 2026-10-26. Session 1 of this plan (78d00a62) then escalated because every partner `read_file` /
   `list_dir` failed (16/16, `ok:false`; `search` worked). That is the intermittent gateway read outage also seen on
   2026-10-22, not a finding on the plan. Files to read for the premises: `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs`,
   `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs`, `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml`,
   `exafyltd/vitana-platform:docs/validation/commit-coverage.json` (schema precedent), and
   `exafyltd/vitana-v1:docs/validation/VTID-05285/staging-tests.json` … `VTID-05294/staging-tests.json`.

## Change (one lane `coverage-manifests`, repo vitana-v1, files only under `docs/validation/`)
- New `docs/validation/commit-coverage.json` (same schema as the platform file): 10 entries, each with the full sha
  from premise 4, its lane VTID, a reason ("merge commit of desktop-spotlight-finish/<lane>; its branch commits carry
  <VTID>; the subject has none"), and `approved_by: "owner, Kiro session kiro-exafyltd-202610220833-d231, 2026-10-26 ('Yes, I approve')"`.
- No new `staging-tests.json`: the covering suites already exist (premise 3).
- No app code, no workflow, no change to VTID-05290/05291/05294. The other plan's lane files are not edited: this plan
  only adds evidence in the folders that plan never created.

## Test plan
- Local: each suite above passes on vitana-v1 `fb9b6d843` (done, see the lane's `commands.log`). A `planRange` dry run with `lib.cjs` over production `1a553367ff66` → lane head lists `missing: []`, all 10 merges `covered`, and
  every manifest valid.
- Staging: the merge is docs-only, so the frontend deploy's `paths` filter does not fire. Under §7d the plan driver
  dispatches `AWS-STAGE-DEPLOY-FRONTEND.yml` on `main`, which deploys and triggers STAGING-VERIFY for that commit.
  Pass = the gate run is green with these 10 commits listed as covered.

## Lanes
- `coverage-manifests` (vitana-v1, seat `exafyltd`, area `frontend`, executor `kiro`, `depends_on: []`). Paths:
  `docs/validation/commit-coverage.json`, `docs/validation/VTID-*/**`. No hot file, no governance path.

## Out of scope
- The stalled desktop-spotlight-finish plan itself (re-spar, lane states).
- The nightly full run hitting its 75 min timeout (`STAGING-VERIFY.yml:94`).
- Making merge-committed PRs carry the VTID in their subject (a PR-GATE change).
<!-- plan:end -->
