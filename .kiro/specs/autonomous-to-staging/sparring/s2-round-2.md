# Sparring round 2 — in_progress

Session: `0b4e3562-119e-4eb3-ba4b-7e56caa8118a` · plan hash `5a97bb3613166549946715e0b31dd7ce8f360f28c80487c80aad363294f3f4df`

## Summary

Round 2 review of the revised plan. All four R1 findings were accepted by the planner and I verified the revisions are reflected in the plan text. I checked key premises against the code and found them accurate. I have two new findings from the revision.

## Findings

### R2-F1 [major]

GATE-INVARIANTS.yml (the workflow that runs the post-merge invariant check on main and daily) is not listed as a protected gate file. The plan adds gate-invariants.mjs to the protected list ('contains every gate file, including itself') and adds VTID-ALLOCATE.yml, but does not mention adding GATE-INVARIANTS.yml. Since .github/workflows/ is only a governance path (queue.mjs:86, collaboration.md:136), not a protected gate file path, a single reviewer-agent accept on a lane PR could delete or gut GATE-INVARIANTS.yml. This would silently remove the post-merge safety net (the bypass-detection check, the daily drift check) while the PR-level invariant check (loaded from merge-base in PR-GATE) would not catch it — it checks code invariants like mergeDecision structure and protected-list contents, not the existence or correctness of the workflow YAML that invokes it on main.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:1` — "globs": [
    "CLAUDE.md",
    "scripts/collab/plan-spar.mjs",
    "scripts/collab/queue.mjs",
    "scripts/collab/protected-gate-files.json",
    "services/gateway/src/services/plan-sparring/**",
    "services/gateway/src/services/project-manager/governance.ts",
    ".github/workflows/PLAN-SPAR.yml",
    ".github/workflows/PR-GATE.yml",
    ".github/workflows/AWS-PROD-*.yml",
    ".kiro/agents/vitana-lane-reviewer.md",
    "supabase/migrations/*vtid_ledger*.sql",
    "supabase/migrations/*plan_sparring*.sql"
  ]
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:86` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
    'CLAUDE.md', 'docs/programs/areas.yaml'];

Suggestion: Add .github/workflows/GATE-INVARIANTS.yml (and .github/workflows/VTID-ALLOCATE.yml, which the plan already says it adds) and scripts/collab/gate-invariants.mjs to the protected gate files list in lane machine-gate-protected. GATE-INVARIANTS.yml is the workflow that enforces the invariants post-merge and detects bypasses; it must have the same protection level as the code it runs. The invariant check should also assert that GATE-INVARIANTS.yml exists and has a push-to-main trigger.

### R2-F2 [minor]

The gate-invariants.mjs invariant 'the staging prod-reference guard still lists every production identifier' references staging-prod-ref-guard.mjs, which is created in lane staging-db-isolation. But gate-invariants.mjs is created in machine-gate-protected, and gate-invariants-ci depends only on machine-gate-protected, not staging-db-isolation. When gate-invariants.mjs first lands, staging-prod-ref-guard.mjs does not yet exist. The plan does not specify how the invariant handles this missing-file case. If the invariant fails closed (as stated), it would block all merges to main until staging-db-isolation lands. If it skips the check, the invariant is not enforced until staging-db-isolation lands and the next PR updates gate-invariants.mjs expectations — creating a window where the guard could be landed incomplete.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:94` — export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs',
    'scripts/collab/protected-gate-files.json', 'services/gateway/src/services/plan-sparring/**',
    'services/gateway/src/services/project-manager/governance.ts', '.github/workflows/PLAN-SPAR.yml',
    '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', '.kiro/agents/vitana-lane-reviewer.md',
    'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql'];

Suggestion: Specify that the staging-prod-ref-guard invariant is conditional on the guard file existing: when the file is absent, the invariant is skipped with a logged note ('staging-prod-ref-guard: not yet present, invariant deferred'). Once staging-db-isolation lands and creates the file, the next PR that updates gate-invariants.mjs expectations (or the next GATE-INVARIANTS.yml daily run on main) picks it up. Alternatively, add staging-db-isolation as a dependency of gate-invariants-ci so they land in order.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed in the revised plan: 'in PR CI both the script and its expectations are loaded from the merge-base (git show "$BASE:scripts/collab/gate-invariants.mjs" > "$RUNNER_TEMP/…")'. The bootstrap exception is also specified (no baseline on merge-base → pass with log).
- R1-F2: acknowledged — Accepted and addressed: GATE-INVARIANTS.yml on main now checks every merge commit that touches a protected gate file for two accept entries from distinct chain models (or the logged bootstrap authority), and fails loudly with an OASIS collab.gate.bypass_detected event.
- R1-F3: acknowledged — Accepted and addressed: clarified as a separate entry point staging-db-apply-migration.sh --cluster <name> --file <f>, cluster required, refuses vitana-aurora-prod unconditionally; --target phrasing removed.
- R1-F4: acknowledged — Accepted and addressed: uses pull_request_target (base-branch workflow and scripts, PR files read as data only), contents: write on the commit job only, same-repo branches only, and VTID-ALLOCATE.yml added to protected-gate-files.json.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
