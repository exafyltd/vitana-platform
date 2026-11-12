#!/usr/bin/env bash
# VTID-05692: reproduces every check in commands.log. Read-only: local git, node tests, GitHub REST GET.
# Run from the vitana-platform worktree root: bash docs/validation/VTID-05692/run-checks.sh > docs/validation/VTID-05692/commands.log
set -u
PIN=6dc6e1ba0c18252ec2f3fbf5651d245e200f9835
D=docs/programs/strategy-execution/oasis-vtid-traceability.md
NEG="${TMPDIR:-/tmp}/neg-05692.md"
run() { echo "\$ $*"; bash -c "$*" 2>&1; echo "exit=$?"; echo; }
echo "# VTID-05692 commands.log (strategy-execution-wave1/oasis-traceability)"
echo "# worktree $(pwd), run $(date -u +%FT%TZ)"
echo "# vitana-platform pin $PIN (origin/main at lane start; no newer origin/main used)"
echo
run "git rev-parse HEAD origin/main"
run "git status --porcelain --untracked-files=all"
echo "## AC-2 citation check (full output)"
run "node docs/validation/VTID-05692/citation-check.mjs --repo . --pin $PIN --doc $D --no-emdash"
echo "## AC-3 negative self-test (scratch file, removed after; expect exit 1, failures=5)"
run "printf 'a \`services/gateway/src/routes/vtid.ts:99999\` b \`no/such/file.ts:1\` c \`CLAUDE.md:5-3\` d \342\200\224 x@y.com\n' > $NEG; node docs/validation/VTID-05692/citation-check.mjs --repo . --pin $PIN --doc $NEG --no-emdash --no-email; rc=\$?; rm -f $NEG; exit \$rc"
echo "## AC-4 section 4 row labels (expect 11)"
run "awk '/^## 4\\./{f=1;next} /^### 4\\.1/{f=0} f && /^\\| [A-Z]/{split(\$0,a,\"|\"); gsub(/^ +| +\$/,\"\",a[2]); print a[2]}' $D | grep -v '^Item\$'"
echo "## AC-5 pseudo-VTID counts at the pin"
run "for p in SH-FALLBACK BOOTSTRAP-PUBLISH BOOTSTRAP-DELIVERY BOOTSTRAP-STAGING-VERIFY BOOTSTRAP-AWS-STAGE-DEPLOY; do echo \"== \$p\"; git grep -c \"\$p\" $PIN -- . | sed \"s/^$PIN://\"; done"
run "git grep -n 'SH-FALLBACK\\|BOOTSTRAP-PUBLISH' $PIN -- services scripts .github ':!*test*' | sed \"s/^$PIN://\" | cut -c1-160"
run "P=\"vtid: *['\\\"\\\`][^'\\\"\\\`]+['\\\"\\\`]\"; A=\$(git grep -ohE \"\$P\" $PIN -- 'services/*.ts' ':!*test*' ':!*__tests__*' | wc -l); C=\$(git grep -ohE \"\$P\" $PIN -- 'services/*.ts' ':!*test*' ':!*__tests__*' | grep -cE \"VTID-[0-9]{5}['\\\"\\\`]\"); F=\$(git grep -lE \"\$P\" $PIN -- 'services/*.ts' ':!*test*' ':!*__tests__*' | wc -l); echo literal_vtid_values=\$A files=\$F canonical=\$C non_canonical=\$((A-C))"
run "P=\"vtid: *['\\\"\\\`][^'\\\"\\\`]+['\\\"\\\`]\"; git grep -ohE \"\$P\" $PIN -- 'services/*.ts' ':!*test*' ':!*__tests__*' | grep -vE \"VTID-[0-9]{5}['\\\"\\\`]\" | sed -E 's/vtid: *//; s/[0-9]+/N/g' | awk '{ if (\$0 ~ /BOOTSTRAP-/) print \"BOOTSTRAP-*\"; else if (\$0 ~ /^.VTID-N.\$/) print \"VTID-<4 digits or fewer>\"; else if (\$0 ~ /VTID-/) print \"VTID-<suffix>\"; else if (\$0 ~ /SYSTEM/) print \"SYSTEM\"; else print \"other\"}' | sort | uniq -c | sort -rn"
run "echo distinct_bootstrap=\$(git grep -ohE \"vtid: *['\\\"\\\`]BOOTSTRAP-[A-Z0-9-]+\" $PIN -- 'services/*.ts' ':!*test*' ':!*__tests__*' | sort -u | wc -l) files=\$(git grep -lE \"vtid: *['\\\"\\\`]BOOTSTRAP-\" $PIN -- 'services/*.ts' ':!*test*' ':!*__tests__*' | wc -l)"
run "echo files_referencing_oasis_events_rest=\$(git grep -l 'rest/v1/oasis_events' $PIN -- 'services/*.ts' ':!*test*' | wc -l)"
run "echo fk_to_vtid_ledger=\$(git grep -niE 'references +(public\\.)?vtid_ledger' $PIN -- supabase/migrations | wc -l)"
echo "## AC-6 non-canonical VTID text in the doc, and the gate-mode sentence"
run "grep -noE 'VTID-[0-9]{1,4}\\b|VTID-[0-9]{6,}' $D; grep -n plan_sparring_config $D"
echo "## Evidence reads (GitHub REST GET only)"
run "gh api repos/exafyltd/vitana-platform/actions/runs/42929814848 --jq '{name, conclusion, head_branch, head_sha, created_at}'"
run "gh api 'repos/exafyltd/vitana-platform/pulls/4942/commits?per_page=50' --jq '.[] | select(.sha|startswith(\"37a52d5ec0\")) | .sha[0:10] + \" \" + .commit.author.name + \" \" + .commit.committer.date'"
run "gh api repos/exafyltd/vitana-platform/actions/runs/42847789182 --jq '{name, conclusion, head_sha, created_at}'"
echo "## AC-8 collab tests and preflight"
run "node --test scripts/collab/*.test.mjs 2>&1 | tail -8"
run "node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/strategy-execution-wave1/oasis-traceability --title 'VTID-05692 (strategy-execution-wave1/oasis-traceability): OASIS and VTID traceability design' --no-tests"
