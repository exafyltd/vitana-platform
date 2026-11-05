# Sparring round 1 — in_progress

Session: `80ff16b5-6dc9-4c7d-910c-f72e6277dc0b` · plan hash `13e4981a65c0565eb758840e136ada1c7a37ac8930a3efd9526ae344bf6e8d5f`

## Summary

This plan fixes a real, documented stale-write race in the vitana-v1 I18N-PROPAGATE workflow. The technical design (key-level 3-way merge, retry loop with fresh reset per attempt, fail-loud on errors) is sound in principle. However, **vitana-v1 is not pinned in this sparring session**, so every premise about the existing workflow (line numbers, step contents, file paths, test patterns) cannot be verified against the actual code. The plan claims `spar_refs` should enable vitana-v1 access, but either the handoff.md for this spec doesn't declare it, or the session creation didn't forward `extra_refs`. This is the blocking issue — without verification of the existing code, the plan could be building on wrong assumptions about line numbers, step structure, or path filters that have since changed.

## Findings

### R1-F1 [blocker]

vitana-v1 is not pinned in this sparring session, making every premise about the existing I18N-PROPAGATE.yml, i18n-check.yml, and lib.test.mjs unverifiable. The plan's handoff.md must declare `spar_refs: - exafyltd/vitana-v1: <ref>` so the gateway forwards `extra_refs` and the partner can read vitana-v1 files. Without this, the plan's root-cause analysis (specific line numbers like :181, :220-223, :232, :245-246, :261-266), the i18n-check.yml path filter claim, and the test-pattern claim are all unverifiable assertions. The plan explicitly says 'these premises can be read directly' via spar_refs, but they cannot.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:60` — export function parseSparRefs(fm) { const raw = fm?.spar_refs; if (raw === undefined || raw === null) return []; // FR4: nothing declared → nothing forwarded
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : []; let extraRefs; for (const [r, ref] of declared) { ... (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:128` — if (b.extra_refs !== undefined) { ... for (const [k, v] of Object.entries(b.extra_refs as Record<string, unknown>)) { if (!(PLAN_SPARRING_REPOS as readonly string[]).includes(k) || typeof v !== 'string' || !SHA_RE.test(v)) { throw new SparringError(400, 'extra_refs_invalid'); } extra[k] = v; } }

Suggestion: Ensure the handoff.md for this spec declares `spar_refs: - exafyltd/vitana-v1: main` (or a pinned SHA). Re-run the sparring session so that `extra_refs` is forwarded and the partner can read vitana-v1 files to verify every premise. Without this, the plan cannot pass sparring.

### R1-F2 [minor]

The plan's narrative cross-references wrong line numbers in plan-spar.mjs. It says '`plan-spar.mjs:383-384`, `:257` `extra_refs`' but line 383-384 is about handoff state transitions (`const to = approved ? 'approved' : 'sparred';`) and line 257 is about VTID allocation binding (`bind = false;`). The actual extra_refs resolution is at lines 286-293 (resolving declared spar_refs) and 312-319 (passing extra_refs in the create body).

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:383` — const to = approved ? 'approved' : 'sparred'; // Allocation on: the plan is always Kiro's next move.
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:257` — bind = false;
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const handoffForRefs = path.join(spec, 'handoff.md'); const declared = ... let extraRefs; for (const [r, ref] of declared) { ... (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl }); } ... ...(extraRefs ? { extra_refs: extraRefs } : {}),

Suggestion: Fix the plan's cross-reference to point to the correct lines (286-293 for resolution, 312-319 for forwarding). This is cosmetic but avoids confusion during implementation.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
