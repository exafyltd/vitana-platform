#!/usr/bin/env bash
# Builds docs/validation/VTID-05689/commands.log. Local, read-only commands only.
WT=/projects/sandbox/wt-sew1-destination-identity
cd "$WT" || exit 1
LOG=docs/validation/VTID-05689/commands.log
DOC=docs/programs/strategy-execution/destination-identity-strategy.md
run() { echo "\$ $1" >> "$LOG.tmp"; bash -c "$1" >> "$LOG.tmp" 2>&1; echo "[exit $?]" >> "$LOG.tmp"; echo >> "$LOG.tmp"; }
{
  echo "# VTID-05689 commands.log (strategy-execution-wave1/destination-identity)"
  echo "# Run $(date -u +%Y-%m-%dT%H:%MZ) in $WT (branch kiro/strategy-execution-wave1/destination-identity, uncommitted)."
  echo "# Built by docs/validation/VTID-05689/build-commands-log.sh. Only local git, grep and node commands."
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
echo "## 2. Facts quoted in the doc" >> "$LOG.tmp"
run "git -C ../vitana-v1 show e31bf4627:src/config/domain-tenant-mapping.ts | sed -n '5,8p'"
run "git -C ../vitana-v1 show e31bf4627:src/App.tsx | sed -n '818p;831p'"
run "git -C ../vitana-v1 show e31bf4627:src/lib/guest-auth.ts | sed -n '24,26p'"
run "git -C ../vitana-v1 show e31bf4627:apps/mobile/app.config.ts | sed -n '27,30p;217p'"
run "git -C ../vitana-v1 show e31bf4627:src/lib/tenant-registry.maxina-golden.test.tsx | sed -n '114p'"
run "for f in .kiro/specs/mt-frontend-brand-r3/plan.md .kiro/specs/mt-packs-r2/plan.md; do echo \"\$f: \$(git -C ../vitana-platform show 6dc6e1ba0c:\$f | grep -c -E 'DOMAIN_TENANT_MAP|guest-auth|displayNameOffPortal|/auth')\"; done"
run "git -C ../vitana-platform grep -c 'Mariia Maksina' 6dc6e1ba0c -- services/gateway/src/routes/orb-live.ts"
run "git -C ../vitana-platform grep -n -i 'maria maxina' 6dc6e1ba0c -- services/gateway/src/services/voice-tools/community-member-ranker.ts services/gateway/src/services/orb-tools-shared.ts"
run "git -C ../vitana-platform show 6dc6e1ba0c:.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md | grep -n -E '^(state|vtid):|src/App.tsx'"
echo "## 3. Doc structure (AC-1, AC-2, AC-4, AC-5, AC-6, AC-11)" >> "$LOG.tmp"
run "grep -c -E '^- \*\*(Status|Owner|Pinned HEADs|VTID|Plan):\*\*' $DOC"
run "for p in 'domain-tenant-mapping.ts:5-8' 'App.tsx:818' 'App.tsx:831' 'guest-auth.ts:24-26' 'tenant-registry.ts:75-88' 'maxina-golden.test.tsx:114' 'app.config.ts:27-30' 'app.config.ts:217' 'MULTI-TENANT-PLAN.md:60'; do echo \"\$p: \$(grep -c -F \"\$p\" $DOC)\"; done"
run "for p in 'vitanaland.com is the ecosystem' 'Maxina is an independent destination' 'Vitana is the universal companion' 'Mariia Maksina'; do echo \"\$p: \$(grep -c \"\$p\" $DOC)\"; done"
run "for p in 'Store identifiers are immutable once published' 'ships dark' '.kiro/specs/mt-frontend-brand-r3/plan.md' '.kiro/specs/mt-packs-r2/plan.md' 'lanes/brand-surface-r3.md' 'lanes/persona-pack.md'; do echo \"\$p: \$(grep -c -F \"\$p\" $DOC)\"; done"
run "node -e \"const C=['Verified operational','Verified implemented, not operational','Implemented but incomplete','Designed but not implemented','Deprecated/superseded','Unknown'];const L=require('fs').readFileSync('$DOC','utf8').split('\n').filter(l=>/Status( for the whole set)?:/.test(l)&&!/\*\*Status:\*\*/.test(l)&&!/^Status classes/.test(l));const bad=L.filter(l=>!C.some(c=>l.includes(c)));console.log('status lines',L.length,'without a class',bad.length);process.exit(bad.length?1:0)\""
run "grep -c '| ID | Title | Files | Risk | Owner | Gate |' $DOC"
run "grep -c '—' $DOC"
echo "## 5. Citation check (AC-3)" >> "$LOG.tmp"
run "node docs/validation/VTID-05689/check-citations.mjs $DOC"
echo "## 6. Scope (AC-7, AC-8)" >> "$LOG.tmp"
run "node --input-type=module -e \"import {validateScope} from './scripts/ci/pr-gate/lib.mjs';import fs from 'fs';const e=validateScope(JSON.parse(fs.readFileSync('docs/validation/VTID-05689/scope.json','utf8')),'VTID-05689');console.log(JSON.stringify(e));process.exit(e.length?1:0)\""
run "git status --porcelain --untracked-files=all"
echo "## 7. Collab tests (AC-10)" >> "$LOG.tmp"
run "node --test scripts/collab/*.test.mjs 2>&1 | tail -9"
mv "$LOG.tmp" "$LOG"
# AC-9 runs last over the finished log; its own line is tagged so it does not count itself.
echo "## 8. No live call (AC-9)" >> "$LOG"
N=$(grep -E '^\$ ' "$LOG" | grep -v '#AC-9' | grep -c -E '(curl|psql|supabase |aws |gh |wget)')
printf '%s\n%s\n[exit 0]\n' "\$ grep -E '^\\\$ ' $LOG | grep -v '#AC-9' | grep -c -E '(curl|psql|supabase |aws |gh |wget)'   #AC-9" "$N" >> "$LOG"
