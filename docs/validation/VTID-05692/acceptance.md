# VTID-05692 acceptance (strategy-execution-wave1/oasis-traceability, tasks.md T1-T2)

Doc: `docs/programs/strategy-execution/oasis-vtid-traceability.md`. Pinned HEAD vitana-platform
`6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`. Each AC has a TEST line; results are in `commands.log`.

AC-1 Only the lane paths change: the doc, `docs/validation/VTID-05692/**` and the lane file. No code, schema, flag,
workflow, `CLAUDE.md`, `areas.yaml` or multi-tenant spec change.
TEST: git status --porcelain --untracked-files=all (every entry under the lane paths)

AC-2 Every `path:line` citation in the doc resolves at the pinned HEAD: the file exists and has at least the cited
number of lines; every range ascends. 0 failures.
TEST: node docs/validation/VTID-05692/citation-check.mjs --repo . --pin 6dc6e1ba0c18252ec2f3fbf5651d245e200f9835 --doc docs/programs/strategy-execution/oasis-vtid-traceability.md --no-emdash

AC-3 The citation check itself fails on a missing file, a line past the end, a descending range, an em dash and an
e-mail address (negative self-test).
TEST: node docs/validation/VTID-05692/citation-check.mjs --repo . --pin 6dc6e1ba0c18252ec2f3fbf5651d245e200f9835 --doc <scratch file with 3 bad citations, an em dash, an address> --no-emdash --no-email (expect exit 1, failures=5)

AC-4 T1: the doc gives the current trace path for each item (account/session, VTID, repository and commit, execution
start, execution end, lifecycle events, decisions, evidence, verification, deployment, outcome), each with file:line
and one status class.
TEST: grep -c over the section 4 table rows for the eleven item names (expect 11)

AC-5 T2: the design uses only `oasis_events`, `vtid_ledger`, git trailers and refs, the GitLab mappers and the PM emit
seam; it gives the three ledger-link options (writer validation, FK, reconciler report) with compatibility, and counts
the pseudo-VTIDs (SH-FALLBACK, BOOTSTRAP-PUBLISH and the other carriers) in code.
TEST: the git grep counts in commands.log match section 2.1 of the doc (SH-FALLBACK 3 in 2 files, BOOTSTRAP-PUBLISH 5 in 2 files, 698/479/219 literal vtid values)

AC-6 No parallel ledger, audit history or ID scheme is proposed; the canonical format `VTID-XXXXX` (5 digits) is used
throughout; the plan-sparring gate mode is left unchanged.
TEST: grep -nE "VTID-[0-9]{1,4}\b|VTID-[0-9]{6,}" on the doc lists only quoted legacy examples (VTID-0541) and the regex text; grep -n "plan_sparring_config" on the doc returns only the "no change" sentence

AC-7 Every needed change is a proposed follow-up with title, files, risk, owner and gate; nothing is presented as done.
TEST: section 7 table has the five columns for F1-F9 (manual read by the reviewer agent)

AC-8 Collab tests and preflight. Deploys nothing.
TEST: node --test scripts/collab/*.test.mjs ; node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/strategy-execution-wave1/oasis-traceability --title "VTID-05692 (strategy-execution-wave1/oasis-traceability): ..." --no-tests
