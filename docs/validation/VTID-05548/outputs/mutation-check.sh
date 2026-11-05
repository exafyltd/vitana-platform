#!/usr/bin/env bash
# Mutation check (VTID-05548): each mutation is applied alone to a copy of the lane files; the test file must
# fail for each. Usage: bash docs/validation/VTID-05548/outputs/mutation-check.sh <worktree> (a copy outside the worktree is mutated, never the lane files)
set -u
WT="$1"
S="${MUT_DIR:-$(mktemp -d)}/mut"
run_one() {
  local name="$1" from="$2" to="$3"
  rm -rf "$S"; mkdir -p "$S/scripts/eng/testing" "$S/infra/gitlab-engineering/host/units"
  cp "$WT/scripts/eng/github-bridge.mjs" "$WT/scripts/eng/github-bridge.test.mjs" "$WT/scripts/eng/gitlab-api.mjs" "$S/scripts/eng/"
  cp "$WT/scripts/eng/testing/fake-fetch.mjs" "$S/scripts/eng/testing/"
  cp "$WT/infra/gitlab-engineering/host/units/"vitana-github-bridge.* "$S/infra/gitlab-engineering/host/units/"
  cp "$WT/infra/gitlab-engineering/RUNBOOK-github-bridge.md" "$S/infra/gitlab-engineering/"
  local f="$S/scripts/eng/github-bridge.mjs"
  if ! grep -qF -- "$from" "$f"; then echo "NOOP     $name (pattern not found)"; return; fi
  FROM="$from" TO="$to" node -e 'const fs=require("fs");const f=process.argv[1];const s=fs.readFileSync(f,"utf8");fs.writeFileSync(f,s.replace(process.env.FROM,process.env.TO));' "$f"
  if ! node --check "$f" 2>/dev/null; then echo "INVALID  $name"; return; fi
  local out; out=$(cd "$S" && timeout 300 node --test scripts/eng/github-bridge.test.mjs 2>&1)
  local fails; fails=$(echo "$out" | grep -E '^# fail' | awk '{print $3}')
  if [ "${fails:-0}" -gt 0 ]; then echo "CAUGHT   $name ($fails failing: $(echo "$out" | grep -E '^not ok' | sed -E 's/^not ok [0-9]+ - //' | cut -c1-60 | paste -sd '|' -))"; else echo "SURVIVED $name"; fi
}
run_one 'main merges never accepted' '        c = ps[0];' '        return { base: c, merges };'
run_one 'main merge: any merge accepted (no tree check)' "if (merged.status !== 0 || String(merged.stdout).split('\n')[0].trim() !== tree) return { base: c, merges };" ''
run_one 'landing only by exact sha' 'if (same) return m;' ''
run_one 'no rate-limit pause' "if (e?.code === 'rate_limited') pause.until" "if (false) pause.until"
run_one 'secondary limit not detected' "const secondary = status === 403 && /secondary rate limit|abuse detection/i.test(text);" 'const secondary = false;'
run_one 'no rotation' 'const order = start > 0 ?' 'const order = false ?'
run_one 'no gate-first order (no tier sort)' '.sort((x, y) => x.tier - y.tier)' ''
run_one 'gate results not split: non-success not first' "(s.state === 'success' ? 1 : 0)" '1'
run_one 'gate order per pull request, not across the tick' 'queue.flatMap((q) => q.writes.map((w) => ({ q, ...w }))).sort((x, y) => x.tier - y.tier)' 'queue.flatMap((q) => [...q.writes].sort((x, y) => x.tier - y.tier).map((w) => ({ q, ...w })))'
run_one 'no rotation after a budget stop (resume not set)' 'out.status_resume = q.b;' 'void 0;'
run_one 'gate jobs read like any other job' 'const gate = GATE.has(job?.name);' 'const gate = false;'
run_one 'skipped gate job posted as success' "return gate ? { state: 'failure', description: 'Skipped on GitLab" "return false ? { state: 'failure', description: 'Skipped on GitLab"
run_one 'gate job allowed to fail posted as success' "return gate ? { state: 'failure', description: 'Failed on GitLab;" "return false ? { state: 'failure', description: 'Failed on GitLab;"
run_one 'optional manual gate job posted as success' "return gate ? { state: 'pending', description: 'Manual job" "return false ? { state: 'pending', description: 'Manual job"
run_one 'no pending gate while the pipeline runs' 'if (!want.has(GATE_CONTEXT) && !FINISHED_PIPELINE.has(pipe.status)) {' 'if (false) {'
run_one 'pending gate also after the pipeline ended' ' && !FINISHED_PIPELINE.has(pipe.status)' ''
run_one 'foreign MR rewritten' '} else if (mr.author?.id !== me.id) {' '} else if (false) {'
run_one 'ownership dropped with the GitHub branch' 'if (gl && (gl === entry.pushed || gl === entry.gitlab)) out.branches[b] = entry;' ''
run_one 'assist from any ref' "|| !fromRef.startsWith('refs/heads/assist/')" ''
run_one 'running jobs posted' 'if (!s.settled) continue;' ''
run_one 'clock-hour budget (no sliding window)' 'm > minute - 60' 'm === minute'
run_one 'refused-then-deleted not re-created' 'if (e.landed === gh) return { entry: e, bridged: true };' 'if (e.pushed === gh) return { entry: e, bridged: true };'
run_one 'dry run fetches' 'if (!dryRun) {
    fetchHead();' 'if (true) {
    fetchHead();'
run_one 'quick actions kept' "line.replace(/^(\\s*)\\//, '\$1\\\\/')" 'line'
run_one 'no lease on push' '`--force-with-lease=refs/heads/${branch}:${expect ?? '"''"'}`' "'--force'"
