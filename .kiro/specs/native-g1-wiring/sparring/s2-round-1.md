# Sparring round 1 — in_progress

Session: `8e2ff780-0c8c-4730-9181-adb96525b085` · plan hash `f4cab34697631c4153ce09311bcb57e245c6cec9f8f22267c5e1ec64a57c4583`

## Summary

This plan proposes env/build-profile scaffolding plus a local fixture-gateway smoke for the Wave 1 native app exit path, targeting vitana-v1. The plan is thorough in self-documenting its limitations and has sound governance assignments (executor/reviewer). However, the fundamental problem is that the vast majority of premises are about vitana-v1 code that this session cannot read (confirmed: "no pinned ref for exafyltd/vitana-v1 in this session"). The plan acknowledges this and self-blocks at approved→executing, which is the right gate, but it means true sparring convergence is structurally impossible in this session. I verified all vitana-platform premises I could reach, and they hold. Three findings below.

## Findings

### R1-F1 [blocker]

The plan's core premises — env.ts production guard (lines 82/105/189), push provider injection (setPushProvider at provider.ts:52), app.config.ts APP_PROFILE (line 36), orb-fake-gateway existence (tools/orb-fake-gateway/server.js:1), parity ledger state (435 rows), eas.json non-existence, shell/UI-kit presence — are ALL in vitana-v1 and NONE are partner-verifiable. This session confirmed it cannot read vitana-v1 ('no pinned ref for exafyltd/vitana-v1 in this session'). Search also returns zero results for vitana-v1. The plan's decisions 1–5 and all lane scopes rest on these unverified claims. Approving a plan whose structural decisions are grounded in ~15 unverified premises violates the purpose of sparring (catch wrong premises before execution). The plan's self-block gate (approved→executing blocked until a fresh session reads vitana-v1) is the right fix, but convergence itself should not happen until the premises are verified — otherwise a wrong premise discovered later could invalidate the lane structure.

- `exafyltd/vitana-v1:apps/mobile/src/config/env.ts:1` — Error: no pinned ref for exafyltd/vitana-v1 in this session
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — session = await client.create({ plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY, });

Suggestion: Do not converge this plan in the current session. Once spar-vitana-v1-ref is live and a fresh PLAN-SPAR session can read vitana-v1, re-spar the plan so the partner can verify every vitana-v1 file:line premise (env.ts guards, push provider port, app.config.ts profile, ORB fake gateway, parity ledger, eas.json absence). Convergence should happen only in a session where the partner actually verified the premises the decisions are built on.

### R1-F2 [major]

The plan claims 'the gateway already accepts extra_refs and github-tools.ts already allowlists exafyltd/vitana-v1' as a premise for the spar-vitana-v1-ref lane (the fix that would unblock future sparring). I could not verify this within the tool-call budget. The plan-sparring-service.ts and github-tools.ts files exist in services/gateway/src/services/plan-sparring/ but I was unable to read them. If the gateway does NOT already accept extra_refs in its create/session schema, or if github-tools.ts does NOT allowlist vitana-v1, then the spar-vitana-v1-ref fix (described as two files, no gateway change) would be insufficient and would require a gateway-side change as well — a larger scope than declared.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring` — Directory listing confirms github-tools.ts and plan-sparring-service.ts exist but contents were not read due to tool-call cap
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — client.create({ plan_text, producer, change_class, base_ref, repo, approval_policy }) — no extra_refs field at the pinned commit

Suggestion: In the next sparring round (or in a fresh vitana-v1-capable session), the partner should verify that github-tools.ts allowlists exafyltd/vitana-v1 and that plan-sparring-service.ts / types.ts accept extra_refs in the create-session schema. If either is missing, the spar-vitana-v1-ref lane's scope must expand to include a gateway change.

### R1-F3 [minor]

The spar-vitana-v1-ref lane is listed in the Lanes table as 'ready' with 'next_actor: claude', but the plan text simultaneously says 'UPDATE: spar-vitana-v1-ref is now MERGED to main (PR #4201, merge commit fa73aabd0)'. A lane that is already merged should not appear as 'ready' — it is done. This creates confusion about what work remains and what the dependency graph actually looks like. The deep-link-push-smoke and real-g1-switch lanes do not depend on spar-vitana-v1-ref (correctly), but having a merged lane appear as 'ready' in the active lanes table is misleading.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — The create() call at the pinned commit (7b6425b) has no extra_refs, confirming the fix is not in this commit. But the plan says PR #4201 merged it.

Suggestion: If spar-vitana-v1-ref is truly merged, update the lanes table to show it as 'done' (with its VTID and PR link) rather than 'ready'. If it's not yet merged, remove the UPDATE claiming it is. The plan text should have one consistent state for each lane.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
