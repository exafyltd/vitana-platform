# VTID-05688 acceptance (strategy-execution-wave1/delivery-capacity, tasks.md T1-T2)

Doc: `docs/programs/strategy-execution/delivery-capacity.md`. Pinned HEAD vitana-platform
`6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`, vitana-v1 `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`. Each AC has a TEST
line; results are in `commands.log`.

AC-1 Only the lane paths change: the doc, `docs/validation/VTID-05688/**` and the lane file. `CLAUDE.md`,
`docs/programs/areas.yaml`, automations and every other file are untouched.
TEST: git status --porcelain --untracked-files=all (every entry under the lane paths); git diff --quiet HEAD -- CLAUDE.md docs/programs/areas.yaml .kiro/automations

AC-2 Every `path:line` citation in the doc resolves at its pin (vitana-platform, `vitana-v1/` at the v1 pin,
`vitanaland-strategy/` at strategy commit fb77090e1f): the file exists, has at least the cited lines, ranges ascend.
The doc has no em dash. 0 failures.
TEST: node docs/validation/VTID-05688/citation-check.mjs --repo . --pin 6dc6e1ba0c18252ec2f3fbf5651d245e200f9835 --doc docs/programs/strategy-execution/delivery-capacity.md --alias vitana-v1/=<v1 checkout>@e31bf4627ff3c705c20f8e6b718ce4dd03353b7f --alias vitanaland-strategy/=<strategy checkout>@fb77090e1ffc7d1ef3c250b0aa721768c3df9425 --no-emdash --no-email

AC-3 No personal e-mail address appears in the doc (seat and login names only).
TEST: the same run with --no-email reports "no e-mail address"

AC-4 T1: the inventory gives the seats (`docs/programs/areas.yaml:14-18`), the sessions per seat prefix from commit
trailers over the last 30 days, the lane-log sessions, claim refs and heartbeats, the GitHub commit authors, the GitLab
identities from EV-089 and the Claude Code status (CLAUDE.md "retired" lines, collaboration.md §7 unavailable mode,
CLAUDE_AVAILABLE Unknown).
TEST: the counts in commands.log ("git log --since=2026-10-12 --format=%B origin/main | grep Collab-Session" grouped by prefix, author counts, ref counts, gh api 403 for CLAUDE_AVAILABLE) match sections 2 to 4 of the doc

AC-5 No account is reported active without evidence: every "Activity evidenced" row names a commit SHA or a PR head
read through gh api; availability is never claimed.
TEST: grep -n "Activity evidenced" docs/programs/strategy-execution/delivery-capacity.md; each row carries a SHA or PR number (reviewer agent reads)

AC-6 T2: capacity against the 12 Kiro + 1 Claude Code target, the gaps, and proposed wording for `CLAUDE.md` and
`areas.yaml` given as text for the owner, not applied.
TEST: grep -n "^\*\*P[1-4]\." docs/programs/strategy-execution/delivery-capacity.md (expect 4); AC-1 shows both files unchanged

AC-7 Every needed change is a proposed follow-up with title, files, risk, owner and gate.
TEST: section 8 table rows C1-C6 have five filled columns (reviewer agent reads)

AC-8 Collab tests and preflight. Deploys nothing.
TEST: node --test scripts/collab/*.test.mjs ; node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/strategy-execution-wave1/delivery-capacity --title "VTID-05688 (strategy-execution-wave1/delivery-capacity): ..." --no-tests
