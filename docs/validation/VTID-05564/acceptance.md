Change types: Tooling/docs.

# Acceptance — VTID-05564 (agentic-delivery / lane `sv-cwd`)

Outcome: the next gateway STAGING-VERIFY runs the `existing` suites of VTID-05515, VTID-05516 and VTID-05518 in
`services/gateway`, where they pass (7 + 16 + 32 = 55 tests), so a gateway merge of this plan can reach a passed
STAGING-VERIFY. Before this change every gateway STAGING-VERIFY whose verified commit contains these three manifests
failed on exactly their three `existing` suites and on nothing else: runs 42050099671 (32/35), 42061647712 (35/38),
42078889519 (this plan's merge commit `51c2bead07`, lane prerequisites, 37/40) and 42098033490 (`ec7f45ccb7`, 43/46).
Each manifest gains one line, `"cwd": "services/gateway"`. Nothing deploys.

AC-1: Red on base. On base the three manifests' `existing` tests have no `cwd`, so `runExisting` runs each ref in
`t.cwd || '.'`, the repository root (`scripts/ci/staging-verify/run.mjs:301`). The root's tracked `node_modules` has no
Jest, so `npx` resolves jest@30.5.2 (the same version and npx cache key `b8d86e6551a4f492` as run 42078889519) with no
configuration; Babel cannot parse the gateway's TypeScript tests. Result: 3 of 3 suites FAIL, all 4 test files "Test
suite failed to run" (3 × a Babel `SyntaxError` on TypeScript syntax, 1 × "Must use import to load ES Module"), 0 tests
ran: the same failures and messages as the STAGING-VERIFY runs.
TEST: `HOME=<scratch> node docs/validation/VTID-05564/outputs/replay-existing.mjs --repo <checkout at base d73fec53f9> --vtids VTID-05515,VTID-05516,VTID-05518`
→ `outputs/red-on-base.txt` (0 passed, 3 failed, exit 1). The run citations: `outputs/staging-verify-runs.txt`.

AC-2: Green. With the lane's manifests the same replay runs each ref in `services/gateway` (the gateway's
`jest.config.js` and `ts-jest`): 3 of 3 suites PASS; Tests 7/7 (VTID-05515), 16/16 (VTID-05516), 32/32 (VTID-05518, two
files), 55/55 in total.
TEST: `HOME=<scratch> node docs/validation/VTID-05564/outputs/replay-existing.mjs --repo <lane checkout> --vtids VTID-05515,VTID-05516,VTID-05518`
→ `outputs/green.txt` (3 passed, 0 failed, exit 0).

AC-3: `lib.validateManifest(m, { vtid, service: 'gateway' })`, the check STAGING-VERIFY applies to every change suite
before it runs it (`lib.planRange`, `lib.cjs:327`, called from `run.mjs:383`; `check-pr` makes the same call,
`run.mjs:497`), accepts each changed manifest: the `existing` kind's optional `cwd` must be `.` or a repo-relative
`SAFE_PATH` directory (`scripts/ci/staging-verify/lib.cjs:124`, `:197-199`), and `inside()` (`run.mjs:213-216`) keeps
`services/gateway` inside the repository.
TEST: the replay prints `lib.validateManifest: ok=true errors=[]` for each manifest before running it, on the lane's
manifests (`outputs/green.txt`) and on base (`outputs/red-on-base.txt`).

AC-4: Diff contract: each manifest diff is exactly one added line (`git diff --numstat` = `1 0`), the line is
`      "cwd": "services/gateway",`, and the head JSON equals the base JSON with `cwd` set on its one `existing` test;
every file the PR changes is one of the three manifests, this lane's file or `docs/validation/VTID-05564/**`.
TEST: `node docs/validation/VTID-05564/outputs/diff-check.mjs <base> HEAD` → `outputs/diff-check.txt` (10 pass, 0 fail).

AC-5: Every staging-verify script test stays green.
TEST: `node --test` over the five test files of `scripts/ci/staging-verify/` → `outputs/staging-verify-scripts.txt`
(103 tests, 103 pass, 0 fail).

AC-6: The gateway tests that read every `docs/validation/*/staging-tests.json` stay green with the three changed
manifests (`vtid-04659-staging-checks-use-versioned-urls.test.ts:38-39`, `vtid-04696-staging-checks-follow-asset-bumps.test.ts:36-37`).
TEST: `cd services/gateway && npx jest test/vtid-04659-staging-checks-use-versioned-urls.test.ts test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`
→ `outputs/manifest-readers.txt` (2 suites, 3 tests, all pass).

States:
- A manifest whose `existing` ref names `test/…` paths and has no `cwd`: runs from the repository root and fails
  (AC-1; the four STAGING-VERIFY runs).
- The same manifest with `"cwd": "services/gateway"`: runs in the gateway folder and passes (AC-2).
- The manifests' `http` tests (`/alive`) are unchanged; they already pass in every run (`outputs/staging-verify-runs.txt`).

Surfaces: STAGING-VERIFY for the gateway (`scripts/ci/staging-verify/run.mjs` `runExisting`, `run.mjs:300-316`, called
from `runSuite`, `run.mjs:328`); the three manifests `docs/validation/VTID-05515|05516|05518/staging-tests.json`.

Locales: n/a. Accessibility: n/a.

Contract:
- Manifest side: each of `docs/validation/VTID-05515/staging-tests.json:9`, `VTID-05516/staging-tests.json:9` and
  `VTID-05518/staging-tests.json:9` is the one added line `"cwd": "services/gateway",` in `tests[0]` (`kind: existing`);
  nothing else changes.
- Runner side: `lib.cjs` `validateTest` case `existing` (`lib.cjs:192-205`, `cwd` rule `:197-199`, `SAFE_PATH` `:124`);
  `run.mjs` `runExisting` resolves `t.cwd || '.'` with `inside()` (`run.mjs:301`), runs `ensureDeps` there
  (`run.mjs:303`, `npm ci` when `node_modules` is missing, `run.mjs:228-235`) and spawns the ref with `cwd: cwdAbs`
  (`run.mjs:307`). The manifest is read from the verified commit's checkout (`loadManifest`, `run.mjs:202`).
- Precedent: the same line is already in 308 manifests at base `d73fec53f9` (`git grep -l '"cwd": "services/gateway"'
  d73fec53f9 -- 'docs/validation/*/staging-tests.json'`), for example `docs/validation/VTID-05551/staging-tests.json:11`.

Staging proof: not verified on staging: this PR deploys nothing (it changes only files under `docs/validation/` and
`.kiro/specs/`; `node scripts/ci/staging-verify/run.mjs check-pr` → `outputs/check-pr.txt`), so its merge starts no
staging deploy and has no `staging-tests.json` of its own. The proof is the next gateway STAGING-VERIFY on a commit that
contains this change (the merge of a later gateway lane), to be linked in the lane log; until then AC-1 and AC-2 replay
`runExisting` locally on base and on the lane head.

Red on base: `outputs/red-on-base.txt` — 0 of 3 suites pass, 4 of 4 files fail to run, 0 tests ran (exit 1).
Green: `outputs/green.txt` — 3 of 3 suites pass, 55 of 55 tests (exit 0); staging-verify scripts 103/103; manifest
readers 3/3.

Decisions taken:
1. The red/green test is a replay harness (`outputs/replay-existing.mjs`), not a new repository test: the lane's
   `paths` are the three manifests only, and tasks V2/V3 ask for the refs run "the way run.mjs runs them". The harness
   copies `runExisting`, `inside()` and the env (`PATH`, `HOME`, `CI=1`, `NODE_ENV=test`, `lib.existingEnv`) line for
   line, uses the repository's own `lib.cjs` (`validateManifest`, `existingEnv`, `summarizeFailure`), and runs only the
   `existing` tests: the manifests' `http` tests call staging, which a builder session never does.
2. `ensureDeps` is replayed without its install: where `run.mjs` would run `npm ci`, the harness stops. The repository
   root carries a tracked `node_modules`, so `run.mjs` runs no `npm ci` there either (run 42078889519 logs `npm ci` only
   for `services/gateway`); for `services/gateway` the sandbox's dependency cache is hard-linked in place of `npm ci`.
3. `HOME` for the replay is a scratch folder outside the repository, so `npx`'s download of jest@30.5.2 (the root case,
   as on CI; npm checks each tarball against the registry's published sha512 integrity) lands outside the repository.
4. The task's command `node --test scripts/ci/staging-verify/` runs on Node 20 (UNIT.yml), which expands a directory to
   its test files; the sandbox has Node 22.23.4, which treats the directory as a module path (recorded in
   `outputs/staging-verify-scripts.txt`). The same five test files are passed explicitly, found the way UNIT.yml finds
   them. No second Node version was installed.
5. AC-6 (the two gateway tests that read every manifest) is a check beyond V3, run because those tests read the three
   changed files; it adds no file to the PR.
6. The lane file says every gateway STAGING-VERIFY since 14:57Z failed. Run 42063399508 (16:20Z) passed, but it verified
   the production commit `2002283504` (smoke only, 12/12), which contains none of the three manifests; every run whose
   verified commit contains them failed on exactly their suites (`outputs/staging-verify-runs.txt`).
7. `scope.json` uses `kind: feature`, the builder protocol's template, and lists this lane's own file next to the three
   manifests and the evidence folder, as the sibling lanes do (VTID-05551, VTID-05554).
8. Local checks ran on Node 22.23.4 (the sandbox's Node); CI runs STAGING-VERIFY on Node 20 (`STAGING-VERIFY.yml:178`).
