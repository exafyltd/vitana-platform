# VTID-05687 acceptance (strategy-execution-wave1/ch-discovery, tasks.md T1-T2)

Docs-only lane. Each AC maps to the common acceptance and the `ch-discovery` acceptance in
`.kiro/specs/strategy-execution-wave1/tasks.md`. Each AC has a TEST: line. The commands and their output are in
`commands.log`. Change types: Tooling/docs.

AC-1 Only the lane paths change: `docs/programs/strategy-execution/command-hub-discovery.md` and
`docs/validation/VTID-05687/**` (the lane file is updated by the orchestrator). No code, schema, flag, workflow,
`CLAUDE.md`, `areas.yaml` or multi-tenant spec changes.
TEST: git status --porcelain (commands.log step 6) lists only those paths.

AC-2 All 26 sections of `NAVIGATION_CONFIG` (`app.js:3236-3549`) and all 135 tabs are listed. Each tab names its render
function with a file:line, and at least one API route with the serving route file:line and auth, or says "API: none"
(static / placeholder) with the line, or has an API note with the line.
TEST: python3 tab-coverage check (commands.log step 4): 26 sections, 135 tab blocks, 0 without an API route or a cited
static line.

AC-3 Every `file:line` and `file:a-b` citation resolves on the pinned HEAD `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`:
the file exists and has at least that many lines. Each route citation after an arrow points at a route definition, and
each render citation names the function at that line.
TEST: inline citation check script (commands.log step 3): failures 0.

AC-4 Every statement about a system carries one status class. No tab is "Verified operational", because no run id was
read (the lane calls no live system).
TEST: grep -c '^  - Status:' equals 135 and grep -c 'Status: Verified operational' equals 0 (commands.log step 5).

AC-5 The target supervisory design (section 6) reads only existing sources: `vtid_ledger`, `oasis_events`,
`.kiro/specs` lane files, claim refs, driver heartbeat refs, GitLab webhook events (`routes/internal-gitlab-webhook.ts`,
`services/gitlab-events/delivery-mapper.ts`), the Delivery summary (`routes/delivery.ts`) and existing read routes.
GitLab stays authoritative for source, MRs, reviews and CI/CD. No new store or execution engine is proposed (section
6.4 says so explicitly).
TEST: reviewer reads section 6; every source row in 6.2 carries a file:line that passes AC-3.

AC-6 The PUBLISH conflict (`routes/operator.ts:2202-2219` against `CLAUDE.md` rules 46 and 50) is stated for the owner
with its provenance (VTID-05620) and without a recommendation to change code.
TEST: reviewer reads section 7; it ends with the two options and "This lane makes no recommendation and changes
nothing."

AC-7 Every needed change is a proposed follow-up with title, files, risk, owner and gate; none is presented as done.
TEST: reviewer reads section 8 (14 rows, 5 columns each).

AC-8 Plain English, no em-dash chains.
TEST: grep -c "—" on the doc equals 0 (commands.log step 5).

AC-9 The collab tests pass. Deploys nothing.
TEST: node --test scripts/collab/*.test.mjs (commands.log step 2). `node scripts/collab/preflight.mjs` judges the
committed HEAD, so the orchestrator runs it on the lane commit before push.
