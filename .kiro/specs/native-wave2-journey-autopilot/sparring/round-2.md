# Sparring round 2 — in_progress

Session: `89b36d49-f10d-4101-a12c-a5011b92ac29` · plan hash `f156730ab5bb404ce9f1261f91aed18a0ebc376310b5202d2c47d0127d28cae9`

## Summary

vitana-v1 remains inaccessible in this Round 2 session despite the planner accepting R1-F1 and adding `spar_refs` to handoff.md. The structural reason is architectural: `spar_refs` resolves into `extraRefs` which is only spread into `client.create` (plan-spar.mjs:319); Round 2 takes the `in_progress` branch at line 322 and calls `client.round` (line 333), which never forwards `extra_refs`. The gateway's pinned refs come from the stored Round 1 session, which was created without vitana-v1. The tool error "no pinned ref for exafyltd/vitana-v1 in this session" confirms this. Every load-bearing premise — IO-free classification of `horizonBuckets.ts`/`vitana-projection.ts`, `packages/core/manifest.json:59` type re-export, all `apps/mobile/**` file assertions — remains unverified. The plan cannot converge in this state.

## Findings

### R2-F1 [blocker]

vitana-v1 is still inaccessible in this Round 2 session. The planner accepted R1-F1 and added `spar_refs: - exafyltd/vitana-v1: main` to handoff.md, but this fix cannot take effect for an already-created, in-progress session. The `spar_refs` mechanism IS implemented at the pinned commit — `parseSparRefs` + `resolveRef` populate `extraRefs` at plan-spar.mjs:281–293 — but `extraRefs` is only spread into the `client.create` body at line 319, inside the `!cur || retryInfra || replan` branch (line 308). Round 2 of this session takes the `cur.verdict === 'in_progress'` branch at line 322 and calls `client.round` at line 333, which carries no `extra_refs`. The gateway pins `repo_refs` from the session record created in Round 1 — a session that was created without vitana-v1 (R1-F1). The tool error 'no pinned ref for exafyltd/vitana-v1 in this session' is direct confirmation. The planner's fix is correct in principle but is structurally unable to affect an existing in-progress session. A new session (via escalation + retryable infra, or escalation + replan) is required to pick up the `spar_refs` entry at `client.create` time.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:287` — const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : [];
    let extraRefs;
    for (const [r, ref] of declared) {
      if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(`spar_refs: ${r} is not an allowed sparring repo`); // FR5
      if (r === repo) throw new Usage(`spar_refs: ${r} is the plan's own repo; it is pinned by --base-sha`);
      (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl }); // FR2/FR3
    }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:308` — if (!cur || retryInfra || replan) {
      action = !cur ? 'create' : retryInfra ? 'retry' : 'replan';
      if (retryInfra) state.sessions.pop();
      session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
        ...(extraRefs ? { extra_refs: extraRefs } : {}),
      });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:322` — } else if (cur.verdict === 'in_progress') {
      const n = cur.rounds;
      ...
      action = 'round';
      session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });
- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:119` — a later `client.round` forwards nothing (the gateway pins refs from the stored round's `repo_refs`,
`plan-sparring-service.ts:356-358`). So the merge (CLI arg overlaid by `spar_refs`), the `resolveRef`
call and the fail-loud contract all live **inside** the `if (!cur || retryInfra || replan)` branch
where `client.create` runs, and are spread into that single `create` (`:192-196`). The
`round`/`waiting_for_planner`/`nothing_to_do` paths never touch `spar_refs`

Suggestion: The session created in Round 1 cannot retroactively acquire vitana-v1 access. The only paths to a new `client.create` are: (a) this session escalates with `infra: true, retryable: true`, which triggers `retryInfra` and pops the old session before creating a fresh one with `spar_refs` applied; or (b) this session escalates non-infra and the plan text changes, triggering `replan`. The planner should explicitly escalate via one of these mechanisms — or request the pipeline operator to mark this session as an infra-retryable escalation — so that the next `step()` invocation hits the `client.create` branch and picks up the `spar_refs: - exafyltd/vitana-v1: main` entry. Only then can a sparring session independently verify the vitana-v1 premises. No policy approval or convergence should be issued from this session.

### R2-F2 [major]

All load-bearing premises from R1-F2 remain unverifiable in this Round 2 session. The revised plan adds a self-assertion — 'Confirmed IO-free premise: at the pinned commit both helpers import no @/integrations/supabase/client and no @/lib/community-gateway' — but this is the planner attesting to their own code, not independent verification. The sparring partner cannot read `src/lib/horizonBuckets.ts`, `src/lib/vitana-projection.ts`, `packages/core/manifest.json`, `apps/mobile/app/(app)/[...path].tsx`, or any other vitana-v1 file (confirmed by R2-F1 above). Additionally, `scripts/native` — which houses `core-closure.mjs`, `parity-ledger.mjs`, and `parity-scope.json` referenced throughout the test plan — does not exist in vitana-platform at the pinned commit. All three scripts are in vitana-v1 and are equally inaccessible. If either autopilot helper has a runtime import of `@/integrations/supabase/client` or `@/lib/community-gateway`, the journey-lane PR will fail the NATIVE-CI `core-closure --check` gate after implementation is complete — exactly the failure mode the sibling plan's `post-attachment.ts` demonstrated.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:56` — That matters: giving them a core entry would pull them into the
`core-closure.mjs` BFS, where their *runtime* imports (`matchReason.ts:1` → `@/lib/i18n-toast`; `post-attachment.ts:11`
→ `@/integrations/supabase/client.ts`, a class-B module with `import.meta.env` / `localStorage` / the prod Supabase
URL) make `core-closure --check` fail (`core-closure.mjs:150`, `m.own !== 'A'`).
- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:17` — the gateway pins the partner's `read_file`/`list_dir` tools to
`input.repo` at `input.base_ref` only. Any finding about the frontend half is made blind, and the
partner's evidence rule (every finding cites a file it read) cannot be met for `vitana-v1`.

Suggestion: Once R2-F1 is resolved and a new session is created with vitana-v1 pinned, the sparring partner must independently read `src/lib/horizonBuckets.ts` and `src/lib/vitana-projection.ts` in full to confirm the absence of any `@/integrations/supabase/client` or `@/lib/community-gateway` runtime import, and read `packages/core/manifest.json` around line 59 to confirm the `src/types/autopilot.ts` type re-export entry exists. These checks must appear as cited evidence in the sparring record before the plan can converge.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
