# Sparring round 2 — in_progress

Session: `d0c274cd-a9f0-48dd-a0a1-ea6061a344b6` · plan hash `854f29e7542a7a91735152306ace7c10970a76527bed630471f263db2d0b0031`

## Summary

All three Round 1 findings were accepted and properly addressed in the revised plan. Two new findings arise from the revision: one blocker (the retire follow-up has no VTID or lane, violating non-negotiable governance rules) and one major (the new tree-wide inventory gate will fire on existing functions that predate _shared/caller-auth.ts, but the plan does not enumerate those functions, leaving the allowlist scope undefined and the lane paths incomplete).

## Findings

### R2-F1 [blocker]

The plan's retire follow-up — editing SUPABASE-FUNCTIONS-RETIRE.yml to add linkedin-import to the ALLOWLIST and dispatching the workflow — is explicitly described as 'No second lane for (2); it is a one-line governance action tracked in handoff.md.' This violates three non-negotiable governance rules simultaneously. (1) CLAUDE.md rule 2b: every commit needs its own VTID allocated before touching code. (2) CLAUDE.md NEVER rule 3: 'Never execute without a VTID.' (3) collaboration.md §3a: any change to a .github/** governance path from a lane that is not executor:claude fails the PR-GATE Lane-scope check — and 'no second lane' means there is no lane at all, so there is no PR-GATE to enforce anything. Without a formal executor:claude lane carrying a VTID, the ALLOWLIST edit is either: (a) a commit with no VTID (violates rules 2b/3), or (b) an informal action outside any lane that the PR-GATE cannot gate. Either way, the plan's own stated S-J closure condition — 'satisfied only once that run reports it absent' — has no CI or governance mechanism ensuring it is ever executed. The deployed linkedin-import function remains callable on production indefinitely.

- `exafyltd/vitana-platform:CLAUDE.md:143` — Always self-allocate the VTID. Every new task — a bug report, a feature ask, a 'fix this,' a doc change, anything that results in a commit — gets its own VTID, allocated by Claude itself... at the START of the work, BEFORE touching any code. This is standing, permanent governance
- `exafyltd/vitana-platform:CLAUDE.md:257` — 3. **Never execute without a VTID.**
4. **Never deploy without OASIS approval.**
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:99` — The PR-GATE check **Lane scope** fails a lane PR that changes anything else, and any change to a governance path (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`, `docs/programs/areas.yaml`) from a lane that is not `executor: claude`.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:159` — Applies to Kiro (as executor, reviewer or planner), and to Claude Code whenever it executes a lane. They never: ... merge or approve a PR on GitHub (the Project Manager merges), dispatch a workflow, or deploy;

Suggestion: Add a second executor:claude lane (e.g. s-j-retire-function) to this spec with paths: ['.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml'] (in vitana-v1), depends_on: [s-j-route-inventory], and a reserved VTID. The lane's single commit adds linkedin-import to the ALLOWLIST; the dispatch and Confirm read are then the lane's post-commit step under that VTID. This satisfies rule 2b/3 (VTID before touching code), the Lane-scope gate (executor:claude for a .github/** change), and gives the S-J closure condition a formal enforcement path in CI.

### R2-F2 [major]

The new check-edge-function-auth.mjs inventory gate walks all of supabase/functions/** and requires each function to either import _shared/caller-auth.ts AND call a gate function, or appear on an explicit in-file public allowlist. The VTID-05044 scan — the last authoritative all-functions inventory — explicitly documented multiple functions in that same tree that use their own pre-_shared/caller-auth.ts auth patterns and are NOT expected to import it: get-proactive-context (getUser/getClaims), generate-proactive-greeting (getUser/getClaims), remove_super_admin (exafy check), send-test-user-confirmation (shared secret), process-campaign-queue (verify_jwt=false with no JWT caller). The plan does not enumerate which existing functions pass the new gate vs. require allowlisting, and does not include those function files in the lane's paths. On first run in CI the gate will fire on every such function, forcing the implementer to either (a) expand scope — touching files outside the declared lane paths, which PR-GATE Lane-scope will reject — or (b) add them all to the allowlist without a prior security review, undermining the gate's intent.

- `exafyltd/vitana-platform:docs/validation/VTID-05044/plan-sparring.md:21` — Scan result: every other service-role function either checks the caller with `getUser`/`getClaims` and compares it to the body id (`get-proactive-context:41-56`, `generate-proactive-greeting:40-55`, `remove_super_admin` exafy check), uses a shared secret (`send-test-user-confirmation:60`), or takes no user id at all.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:98` — paths: the only files the lane may change (Lane scope); required from executing on ... The PR-GATE check **Lane scope** fails a lane PR that changes anything else

Suggestion: Before finalising the lane, enumerate the full supabase/functions/** tree and classify each function as: (A) already imports _shared/caller-auth.ts (passes gate), (B) uses a pre-existing auth pattern acceptable as a documented allowlist entry (list it in the plan with its stated reason), or (C) ungated and requiring a fix. Add the allowlist-entry files for class B to the lane's paths so PR-GATE does not reject them. Class C functions are out of scope for this lane but should be tracked as residuals in handoff.md. This enumeration eliminates the ambiguity about CI pass/fail on first run and makes the lane's true scope visible before implementation starts.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly addressed. The revised plan pins vitana-v1@32a82e6b6, lists all nine re-verified premises with corrected line numbers, and adds a T1 pre-flight check that halts the lane on any mismatch. The gap is closed.
- R1-F2: acknowledged — Properly addressed. The S-E closure record now accurately states 'this RPC checks ONLY open_signup' with the is_active/NOT is_platform triple correctly attributed to the signup triggers. The residual hardening is tracked in Out of scope and handoff.md for the WS3 join-flow slice. The rationale (open_signup defaults false, no tenant has is_platform yet) is sound.
- R1-F3: acknowledged — Properly addressed. The S-J record now reads 'dev-sandbox-only and ANONYMOUS (no requireAuth)' and adding requireAuth is explicitly listed under Out of scope as a WS0 route-inventory backlog item. The documentation no longer misrepresents the security posture.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
