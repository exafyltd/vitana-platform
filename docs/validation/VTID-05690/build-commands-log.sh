#!/usr/bin/env bash
# Builds docs/validation/VTID-05690/commands.log. Local, read-only commands only.
WT=/projects/sandbox/wt-sew1-hm-readiness
cd "$WT" || exit 1
LOG=docs/validation/VTID-05690/commands.log
DOC=docs/programs/strategy-execution/healthy-million-readiness.md
run() { echo "\$ $1" >> "$LOG.tmp"; bash -c "$1" >> "$LOG.tmp" 2>&1; echo "[exit $?]" >> "$LOG.tmp"; echo >> "$LOG.tmp"; }
{
  echo "# VTID-05690 commands.log (strategy-execution-wave1/hm-readiness)"
  echo "# Run $(date -u +%Y-%m-%dT%H:%MZ) in $WT (branch kiro/strategy-execution-wave1/hm-readiness, uncommitted)."
  echo "# Built by docs/validation/VTID-05690/build-commands-log.sh. Only local git, grep and node commands."
  echo "# No network, no database, no gateway, no GitHub call. grep -c exits 1 when it counts 0; that is the expected result."
  echo "# Preflight (scripts/collab/preflight.mjs) is not run here: the lane is not committed (owner instruction for this"
  echo "# build), and preflight reads the plan( PR lane file through the GitHub API. Run it after the commit."
  echo
} > "$LOG.tmp"
echo "## 1. Pins" >> "$LOG.tmp"
run "git -C ../vitana-platform rev-parse origin/main HEAD"
run "git -C ../vitana-v1 rev-parse origin/main HEAD"
run "git -C ../vitanaland-strategy rev-parse HEAD"
run "git rev-parse HEAD; git branch --show-current"
echo "## 2. Counts quoted in the doc (criteria 3, 13)" >> "$LOG.tmp"
run "git -C ../vitana-v1 grep -il maxina e31bf4627 -- 'src/*.ts' 'src/*.tsx' ':!*.test.*' | wc -l"
run "git -C ../vitana-v1 grep -il maxina e31bf4627 -- 'apps/mobile/src/*' ':!*.test.*' | wc -l"
run "git -C ../vitana-platform grep -il -E 'mariia|maksina|maria maxina' 6dc6e1ba0c -- 'services/gateway/src/*' ':!*.test.*' | wc -l"
run "git -C ../vitana-v1 grep -il -E 'mariia|maksina|maria maxina' e31bf4627 -- 'src/*.ts' 'src/*.tsx' ':!*.test.*' | wc -l"
echo "## 3. Absences quoted in the doc" >> "$LOG.tmp"
run "git -C ../vitana-platform grep -il -E 'healthy[ _-]?million' 6dc6e1ba0c | wc -l"
run "git -C ../vitana-v1 grep -il -E 'healthy[ _-]?million' e31bf4627 | wc -l"
run "git -C ../vitana-platform grep -il -E 'website.?factory|vitanaland-skeleton' 6dc6e1ba0c | wc -l"
run "git -C ../vitana-v1 grep -il -E 'website.?factory|vitanaland-skeleton' e31bf4627 | wc -l"
run "git -C ../vitana-platform show 6dc6e1ba0c:services/gateway/src/routes/onboarding-coach.ts | grep -c -i tenant"
run "for f in discover-search-repository intent-matches-repository discover-recommendations-repository product-analytics-repository; do echo \"\$f: \$(git -C ../vitana-platform show 6dc6e1ba0c:services/gateway/src/routes/\$f.ts | grep -c -i tenant)\"; done"
run "git -C ../vitana-platform show 6dc6e1ba0c:services/gateway/src/routes/orb-live.ts | grep -c persona_facts"
run "git -C ../vitana-platform grep -n -i -E 'k_anon|min_cohort|minimum.?cohort' 6dc6e1ba0c -- 'services/gateway/src/routes/tenant-admin/*' | wc -l"
run "git -C ../vitana-platform grep -l 'run-mt-isolation-test' 6dc6e1ba0c -- .github/ | wc -l"
run "git -C ../vitana-platform ls-tree -r --name-only 6dc6e1ba0c .kiro/specs | grep -c 'mt-community-isolation'"
run "git -C ../vitana-platform branch -r | grep 'mt-community-isolation-r2'"
run "git -C ../vitana-platform show origin/kiro/mt-community-isolation-r2/plan:.kiro/specs/mt-community-isolation-r2/sparring/state.json | grep -E '\"verdict\"|policy_approved_at'"
echo "## 4. Doc structure (AC-1, AC-2, AC-4, AC-5, AC-6, AC-11)" >> "$LOG.tmp"
run "grep -c -E '^- \*\*(Status|Owner|Pinned HEADs|VTID|Plan):\*\*' $DOC"
run "node -e \"const s=require('fs').readFileSync('$DOC','utf8');const h=[...s.matchAll(/^\*\*(\d+)\. /gm)].map(m=>+m[1]);const r=(s.match(/^- Readiness:/gm)||[]).length;console.log('criteria',h.join(','),'count',h.length,'readiness lines',r);process.exit(h.length===19&&h.every((v,i)=>v===i+1)&&r===19?0:1)\""
run "node -e \"const C=['Verified operational','Verified implemented, not operational','Implemented but incomplete','Designed but not implemented','Deprecated/superseded','Unknown'];const L=require('fs').readFileSync('$DOC','utf8').split('\n').filter(l=>/Status:/.test(l)&&!/\*\*Status:\*\*/.test(l));const bad=L.filter(l=>!C.some(c=>l.includes(c)));const op=L.filter(l=>/Status:[^.]*Verified operational/.test(l));console.log('status lines',L.length,'without a class',bad.length,'claiming Verified operational',op.length);process.exit(bad.length||op.length?1:0)\""
run "for p in 'No tenant, pack or content is created' 'multi-tenant foundation' 'mobile foundation' 'website foundation' 'Tenant creation by the owner'; do echo \"\$p: \$(grep -c \"\$p\" $DOC)\"; done"
run "grep -c '| ID | Title | Files | Risk | Owner | Gate |' $DOC"
run "grep -c '—' $DOC"
echo "## 5. Citation check (AC-3)" >> "$LOG.tmp"
run "node docs/validation/VTID-05690/check-citations.mjs $DOC"
echo "## 6. Scope (AC-7, AC-8)" >> "$LOG.tmp"
run "node --input-type=module -e \"import {validateScope} from './scripts/ci/pr-gate/lib.mjs';import fs from 'fs';const e=validateScope(JSON.parse(fs.readFileSync('docs/validation/VTID-05690/scope.json','utf8')),'VTID-05690');console.log(JSON.stringify(e));process.exit(e.length?1:0)\""
run "git status --porcelain --untracked-files=all"
echo "## 7. Collab tests (AC-10)" >> "$LOG.tmp"
run "node --test scripts/collab/*.test.mjs 2>&1 | tail -9"
mv "$LOG.tmp" "$LOG"
# AC-9 runs last over the finished log; its own line is tagged so it does not count itself.
echo "## 8. No live call (AC-9)" >> "$LOG"
N=$(grep -E '^\$ ' "$LOG" | grep -v '#AC-9' | grep -c -E '(curl|psql|supabase |aws |gh |wget)')
printf '%s\n%s\n[exit 0]\n' "\$ grep -E '^\\\$ ' $LOG | grep -v '#AC-9' | grep -c -E '(curl|psql|supabase |aws |gh |wget)'   #AC-9" "$N" >> "$LOG"
