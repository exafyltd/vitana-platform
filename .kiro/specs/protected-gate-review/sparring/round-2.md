# Sparring round 2 — in_progress

Session: `efb325d3-2b7b-4734-9d87-86434474508e` · plan hash `20b04f9054648d8ffa3a6251571a8432d213d33018e8572d9322aef7d4382567`

## Summary

All six R1 findings were accepted by the planner; the revised plan addresses them in scope and framing. However, three new material gaps have appeared in the revision. (1) The plan falsely asserts that all three enforcement points are "protected gate files" – `land-guard.mjs` is not in the protected list and needs only a governance-level single accept, not the two-model rule. (2) The gate-invariants anti-regression mechanism (origin/main baseline) cannot protect against a subtly-wrong implementation of Option B's new bypass path; the plan specifies no concrete new assertions to close that gap. (3) Option B still has no code-level specification despite R1-F4 being accepted with the express promise that "each option must specify both stages."

## Findings

### R2-F1 [major]

`land-guard.mjs` is NOT a protected gate file. The revised plan's claim 'Three enforcement points, all protected … a change to any of these files is itself a protected-gate change' is factually wrong for land-guard.mjs, misstating both the merge requirement and the bootstrapping calculus.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:4` — "globs": [
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
  "supabase/migrations/*plan_sparring*.sql",
  ".github/workflows/VTID-ALLOCATE.yml",
  "scripts/collab/gate-invariants.test.mjs"
]
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:94` — export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json', 'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts', '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql',
  // VTID-05765 (plan autonomous-to-staging): VTID allocation and the gate-invariant check and its workflow.
  '.github/workflows/VTID-ALLOCATE.yml', 'scripts/collab/gate-invariants.test.mjs'];
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:48` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
  'CLAUDE.md',
  'scripts/collab/plan-spar.mjs',
  'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json',
  'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts',
  '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml',
  '.github/workflows/AWS-PROD-*.yml',
  '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql',
  'supabase/migrations/*plan_sparring*.sql',
  '.github/workflows/VTID-ALLOCATE.yml',
  'scripts/collab/gate-invariants.test.mjs',
]);
- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:22` — export const REQUIRED_PROTECTED = Object.freeze([
  'CLAUDE.md',
  'scripts/collab/plan-spar.mjs',
  'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json',
  'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts',
  '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml',
  '.github/workflows/AWS-PROD-*.yml',
  '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql',
  'supabase/migrations/*plan_sparring*.sql',
  '.github/workflows/VTID-ALLOCATE.yml',
  'scripts/collab/gate-invariants.test.mjs',
]);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:86` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];

Suggestion: Correct the plan's scope table: land-guard.mjs is a *governance path* (covered by `scripts/collab/**` in GOVERNANCE_PATHS), not a protected gate file. It needs a single governance-level reviewer-agent accept to change, not the two-model rule. The bootstrapping section must distinguish: (a) queue.mjs, governance.ts, gate-invariants.test.mjs, and protected-gate-files.json — all true protected gate files requiring two distinct-model accepts; (b) land-guard.mjs — governance path only, one accept sufficient. This also means the plan must not accidentally trigger an ADD of land-guard.mjs to protected-gate-files.json (that itself would be an unspecified scope change to a protected file).

### R2-F2 [major]

The gate-invariants.test.mjs anti-regression baseline (the origin/main copy) cannot detect a subtly-wrong implementation of Option B's new bypass path, and the plan provides no specification of what new invariant assertions must enforce Option B's conditions. This was the core of the R1-F2 acceptance ('assertions are updated with the chosen option') but remains unaddressed.

- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:94` — T('merge-base copy of gate-invariants.mjs holds on this checkout (bootstrap when absent)', async (t) => {
  let src = null;
  try { src = git('show', 'origin/main:scripts/collab/gate-invariants.test.mjs'); } catch { /* not on main yet */ }
  if (!src) { t.diagnostic('gate-invariants: no baseline on merge-base (bootstrap)'); return; }
  ...
  const { checkInvariants: baseline } = await import(pathToFileURL(file).href);
  ...
  const { failures, notes } = await baseline(ROOT);
  assert.deepEqual(failures, []);
});
- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:70` — for (const [label, models] of [['zero accepts', []], ['one accept', [MODELS[0]]], ['two accepts of one model', [MODELS[0], MODELS[0]]]]) {
  if (lg.mergeDecision({ ...base, protectedModels: models }).ok) failures.push(`land-guard.mjs merges a protected gate file with ${label}`);
}
if (!lg.mergeDecision({ ...base, protectedModels: MODELS }).ok) failures.push('land-guard.mjs refuses two accepts from different models (rule not in force)');
if (lg.protectedAcceptModels([{ verdict: 'accept', reviewer: 'agent:vitana-lane-reviewer (gpt-x)', current: true }]).length) failures.push('land-guard.mjs counts a model outside the chain');
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:134` — export function mergeDecision({ review, checks, behindBy, protectedFiles = [], protectedModels = [] }) {
  if (protectedFiles.length) {
    const distinct = new Set(protectedModels);
    if (distinct.size < PROTECTED_ACCEPTS_REQUIRED) return { ok: false, code: 1, reason: `protected gate file(s) changed (${protectedFiles.join(', ')}): needs ${PROTECTED_ACCEPTS_REQUIRED} reviewer-agent accepts from different chain models on the current head ...` };
  }

Suggestion: The plan must specify the concrete new invariant assertions gate-invariants.test.mjs must contain for Option B. Specifically: (1) a mutation test that sets the bypass condition without meeting its requirements (e.g., owner token present but plan does not name the changed files) and asserts that mergeDecision still returns ok:false; (2) a positive test that a fully-valid owner token covering the exact files does unlock the merge. Without these, the first PR implementing Option B has no anti-regression coverage for the bypass path's correctness conditions — the origin/main baseline only tests the old protectedModels API and cannot see the new code path.

### R2-F3 [major]

Option B's code-level mechanism is entirely unspecified despite R1-F4 being accepted with the rationale 'each option must specify both stages.' The current mergeDecision and protectedAcceptModels signatures have no provision for an owner-approval bypass; the plan provides only a policy statement.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:134` — export function mergeDecision({ review, checks, behindBy, protectedFiles = [], protectedModels = [] }) {
  if (protectedFiles.length) {
    const distinct = new Set(protectedModels);
    if (distinct.size < PROTECTED_ACCEPTS_REQUIRED) return { ok: false, ... };
  }
  if (!review.ok) return { ok: false, ... };
  if (checks.state === 'fail') return { ok: false, ... };
  if (checks.state === 'pending') return { ok: false, ... };
  if (behindBy > 0) return { ok: false, ... };
  return { ok: true, code: 0, reason: 'review current, checks green, up to date' };
}
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:65` — export const PROTECTED_ACCEPTS_REQUIRED = 2;
export function protectedAcceptModels(reviews: readonly ReviewEntry[], pr: ObservedPr | null): string[] {
  if (!pr) return [];
  const models = new Set<string>();
  for (const r of reviews) {
    if (!isAgentReview(r) || !reviewOnCurrentHead(r, pr)) continue;
    const m = /\(([^)]+)\)\s*$/.exec(String(r.reviewer ?? '').trim());
    if (m && REVIEWER_AGENT_MODELS.includes(m[1])) models.add(m[1]);
  }
  return [...models];
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1044` — else if (matchesAny(f, PROTECTED_GATE_PATHS)) {
  // VTID-05765: a trusted two-model lane may change it; the merge then needs two accepts from different models.
  if (isTwoModelLane(fm) && trustedFrom) continue;
  errors.push(`${f} is a protected gate file ... needs protected_gate: ${PROTECTED_GATE_TWO_MODEL} ... or executor: claude`);

Suggestion: For Option B, the plan must specify at minimum: (1) PR-GATE stage — what new lane-file field or token signals 'owner-approved sparred plan', how queue.mjs scopeCheck reads and validates it (what 'trusted source' means for this new field, and how 'plan lists exact protected files' is verified against the lane file's paths at PR-GATE time); (2) Merge-time stage — what new parameter mergeDecision and/or protectedAcceptModels accepts to carry the owner-approval token, what it checks before returning ok:true without two distinct-model accepts; (3) where the token is stored so the land-guard merge command can read it. Without this, the VTID has no implementable specification.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
