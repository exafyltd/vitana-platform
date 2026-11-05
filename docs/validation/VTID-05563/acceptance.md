Change types: Tooling/docs.

# Acceptance — VTID-05563 (agentic-delivery / lane `nav-paths`)

Outcome: lane `gateway-delivery` (VTID-05547) may change the four files its Delivery screen needs besides its own code:
`services/gateway/src/navigation/data/command-hub-screens.json`, `services/gateway/src/navigation/data/nav-embeddings.bin`,
`services/gateway/src/navigation/data/nav-embeddings.json` and `scripts/ci/command-hub-ownership-guard.js`. After this lands,
its builder can land the screen together with the voice-navigation entries, the stored vectors and the ownership-guard line
in one green PR. Nothing deploys.

AC-1: The target `lanes/gateway-delivery.md` gains exactly four `paths` lines, the four files of task N2, and nothing else
changes: `state`, `seat`, `executor`, `reviewer_seat`, `vtid`, `updated`, every other `paths` entry and every log line stay
byte-identical (`git diff --numstat` is `4 0`; the head bytes equal the base bytes with the four lines inserted before
`  - docs/validation/**`; the parsed front matter differs only in `paths`, by the four entries).
TEST: `bash docs/validation/VTID-05563/outputs/target-diff-check.sh origin/main HEAD` → `outputs/target-diff-check.txt`.

AC-2: Collab handoff passes for this PR through the `lane_admin` path. The commit with `Collab-Lane:
agentic-delivery/nav-paths` edits another lane's file; `validateRange` lets that through only because `laneAdminCovers`
reads this lane's trusted front matter (the merge-base: `lane_admin: true`, `executor: kiro`, `reviewer_seat:
agent:vitana-lane-reviewer`) and its `paths` list the target.
TEST: `node scripts/collab/queue.mjs validate --repo . --base origin/main --head HEAD --branch kiro/agentic-delivery/nav-paths`
→ `outputs/validate.txt`.

AC-3: Lane scope passes for lane `agentic-delivery/nav-paths`: its lane file is edited only by this seat `exafy` session,
its permission fields and `lane_admin` are unchanged, and every changed file is inside the lane's spec folder or its
evidence folder.
TEST: `node scripts/collab/queue.mjs scope-check --repo . --base origin/main --head HEAD --branch kiro/agentic-delivery/nav-paths`
→ `outputs/scope-check.txt`.

AC-4: Negative proof: on today's origin/main, a commit of lane gateway-delivery (`Collab-Lane:
agentic-delivery/gateway-delivery`, session `kiro-exafy-202611021438-cff7`, seat `exafy`) that changes the four files fails
Lane scope: 4 problems, one per file ("… is outside lane agentic-delivery/gateway-delivery"), exit 1.
TEST: `bash docs/validation/VTID-05563/outputs/nav-paths-proof.sh negative <origin/main>` → `outputs/red-on-base.txt`.

AC-5: Positive proof: with this PR's tree squashed onto origin/main (as GitHub would), the same commit (same patch-id) passes
Lane scope and Collab handoff, exit 0.
TEST: `bash docs/validation/VTID-05563/outputs/nav-paths-proof.sh positive <origin/main> <this PR's head>` → `outputs/green.txt`.

AC-6: The four files changed by another lane are refused, as before: on the same squashed base, the same change under
`Collab-Lane: agentic-delivery/cutover` fails Lane scope with 4 problems, exit 1.
TEST: `outputs/green.txt`, section "control on the same base S" (same command as AC-5).

AC-7: The PR holds no governance path, protected gate file or code: it changes the target lane file, this lane's own file
and `docs/validation/VTID-05563/**` only; `lane_admin` and this lane's own `paths` are unchanged.
TEST: `bash docs/validation/VTID-05563/outputs/contract-check.sh origin/main HEAD` → `outputs/contract-check.txt`.

AC-8: Preflight (every CI governance check of the PR) passes on the lane head.
TEST: `node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/agentic-delivery/nav-paths
--title "<PR title>"` → `outputs/preflight.txt`.

States:
- The target lane `ready` on `main` with a claim held on its branch (`collab-claim/agentic-delivery/gateway-delivery`,
  `kiro-exafy-202611021438-cff7`, branch `kiro/backup/gateway-delivery`): only the `paths` block changes on `main`. The
  hunk sits between `  - services/gateway/test/delivery/**` and `  - docs/validation/**`, so a builder that adds
  `claimed_by:`/`branch:` after the block merges `main` without touching it.
- The four files changed by another lane: refused, as before (AC-6).

Surfaces: PR-GATE Collab handoff (`queue.mjs validate`) and Lane scope (`queue.mjs scope-check`) for this PR and for lane
gateway-delivery's PR.

Locales: n/a (developer-facing). Accessibility: n/a.

Contract:
- This PR's diff: the target `lanes/gateway-delivery.md` (four added lines at `lanes/gateway-delivery.md:24-27`); this lane's
  own file `lanes/nav-paths.md` (front matter `state`, `claimed_by`, `branch`, `updated`, later `pr`, and appended log
  entries); `docs/validation/VTID-05563/**`. `lane_admin: true` stays at `lanes/nav-paths.md:10`, and this lane's `paths`
  stay the one target (`lanes/nav-paths.md:12-13`).
- Checker side: `validateRange` cross-lane-file exemption `scripts/collab/queue.mjs:873` → `laneAdminCovers`
  `queue.mjs:1096` → `fetchTrustedLaneFm` `queue.mjs:1078` (merge-base first, never the PR head). `scopeCheck`: own spec
  folder and evidence `queue.mjs:1025`, the paths rule `queue.mjs:1031` (the AC-4/AC-6 refusals), permission fields pinned
  to the trusted revision `queue.mjs:1000`, `:1021`, governance and protected-gate rules `queue.mjs:1034-1035` (none of the
  four files is either: `GOVERNANCE_PATHS` `queue.mjs:86`, `scripts/collab/protected-gate-files.json`).
- Consumer side (lane gateway-delivery): `services/gateway/test/navigation/vtid-04814-command-hub-navigation.test.ts:140`
  ("has exactly one screen per tab of NAVIGATION_CONFIG", reads `command-hub-screens.json`),
  `services/gateway/src/navigation/nav-embedder.ts:23-24` (`EMBEDDINGS_META_PATH`/`EMBEDDINGS_BIN_PATH`, the stored
  vectors `nav-embeddings.json`/`.bin`), and the `ALLOWED_VTID_PATTERN` of
  `scripts/ci/command-hub-ownership-guard.js:1051` (the builder's patch adds VTID-05547 there).
- Precedent: lane `say-hello-lane-reassign/reassign` (VTID-05410, `ee1d363dd2`) added paths to a target the same way; lane
  `agentic-delivery/reseat` (VTID-05554, PR #4703, `49cff4a9df`) used the same `lane_admin` path in this plan.

Staging proof: not verified on staging: this PR deploys nothing (lane files and evidence only;
`node scripts/ci/staging-verify/run.mjs check-pr` → `outputs/check-pr.txt`), so there is no `staging-tests.json`. Covered
by AC-2 to AC-6 (Collab handoff and Lane scope on this PR, the negative proof and the positive proof).

Red on base: no new test; the lane changes no code. Its base-versus-lane pair is the gateway-delivery commit that changes
the four files: on today's origin/main Lane scope fails, 4 problems, exit 1 (`outputs/red-on-base.txt`).
Green: with this lane squashed onto origin/main, the same commit passes Lane scope and Collab handoff, exit 0
(`outputs/green.txt`).

Decisions taken:
1. The four lines go before the last entry `  - docs/validation/**`, in the order of task N2, so `docs/validation/**` stays
   last and the line after the block (`updated:`) is untouched.
2. The target keeps its `updated:` value and gets no log entry (N2 lists `updated` and every log line among the bytes that
   stay the same). The record of the change is this lane's log, this PR and this evidence.
3. `scope.json` uses `kind: feature`, the builder protocol's template (the change is Tooling/docs). It lists this lane's
   own file next to the target and the evidence folder, as lane reseat did (VTID-05554).
4. The scratch commits carry the gateway-delivery claim holder's session id `kiro-exafy-202611021438-cff7` (seat `exafy`)
   in local commits only, never pushed, to model that session's own commit (as VTID-05554 decision 3). Their change is the
   builder's own patch for `command-hub-screens.json` and `command-hub-ownership-guard.js`
   (`docs/validation/VTID-05547/outputs/outside-lane-paths.patch` at `594ab32a51`) plus placeholder bytes in the two vector
   files. The real vectors come from one Bedrock call run by the owner or by CI, never from a session (`plan.md:740-742`);
   Lane scope reads only the changed paths.
5. "The same commit" on two bases: the commit is built on each base from the same inputs; equal patch-id and equal sha256
   of `git diff --binary` show the same change (the four files are byte-identical on both bases, since this PR does not
   touch them).
6. The control lane of AC-6 is `agentic-delivery/cutover`: same plan, seat `exafy`, `ready` on main, and its `paths` cover
   none of the four files.
7. Locally, `validate` and `scope-check` ran without `--plan-repo` (`gh pr list` does not work in this sandbox). Every lane
   file they judge here has a merge-base copy, which comes first in the trusted source chain, so the plan-PR source is never
   consulted.
8. Local checks ran on Node 22.23.4 (the sandbox's Node); CI runs the same commands on Node 20.
