# Sparring round 2 — in_progress

Session: `f9549fe4-3a26-439f-b09e-c9c017660e49` · plan hash `6b3cfd0ddcdfc2f1a02ec148919a5ccaf97c4e2d9eab3b814e03e0c9837ec9aa`

## Summary

vitana-v1 is inaccessible for the second consecutive round. The planner accepted R1-F1 and claimed to fix it by adding spar_refs to handoff.md. The fix is architecturally correct for brand-new sessions, but plan-spar.mjs client.round() (line 333) never forwards extra_refs — only client.create() (lines 312–320) does. Because the session was created in Round 1 before spar_refs was added, Round 2 inherits no vitana-v1 binding; a direct read_file attempt against exafyltd/vitana-v1 returned 'no pinned ref for exafyltd/vitana-v1 in this session'. A read_file attempt on the current plan.md also returned a 404 (the spec folder exists only on the PR HEAD branch, not at the pinned base commit 84fc0ca). All nine code premises that drive load-bearing decisions remain unverified. R2-F1 identifies the structural gap in plan-spar.mjs that makes the accepted fix inadequate for mid-session rounds. R1-F2 rejection is acknowledged: the mechanism correctly uses handoff.md spar_refs, not the plan.md header.

## Findings

### R1-F1 [blocker]

vitana-v1 is still inaccessible in Round 2, and the planner's accepted fix does not resolve the problem for this session. The planner added spar_refs: - exafyltd/vitana-v1: main to handoff.md, but plan-spar.mjs only forwards extra_refs inside client.create() (lines 312–320). The client.round() call at line 333 submits only { responses, revised_plan_text } with no extra_refs. Because the session was created in Round 1 before spar_refs was added to the PR branch, the gateway session carries no vitana-v1 binding; a direct read_file call against exafyltd/vitana-v1/src/pages/Messages.tsx returned 'no pinned ref for exafyltd/vitana-v1 in this session'. Additionally, a read_file call against the current plan.md returned a GitHub 404, confirming that the native-wave2-inbox-chat-calls spec folder exists only on the PR HEAD branch and was not present at the base commit when the session was created. All code premises from R1-F3 therefore remain unverified.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:308` — session = await client.create({ plan_text: planText, ..., ...(extraRefs ? { extra_refs: extraRefs } : {}), }); ... session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText }); // no extra_refs in round body
- `exafyltd/vitana-platform:docs/validation/VTID-05253/vitana-v1-spar-evidence.md:14` — The session that actually *converged* this plan (`8e2ff780`) was created before the ref fix was in the plan branch's base checkout, so in that converging round the sparring partner could not `read_file` vitana-v1.

Suggestion: Two actions needed before this plan can converge. (1) Patch plan-spar.mjs so that client.round() also spreads extraRefs (see R2-F1). (2) Because the current session was created without vitana-v1, force a new session after the patch — either by escalating and retrying or opening a new PR — so the partner receives a session created with extra_refs from the start. Until vitana-v1 is readable, R1-F3 premises cannot be discharged.

### R1-F3 [blocker]

The plan's load-bearing premises remain unverified for a second consecutive round. The planner accepted this for Round-2 verification, but Round 2 cannot perform it because vitana-v1 is still inaccessible (read_file returned 'no pinned ref'). The unverified premises are: (1) CallProvider + CallManager mounted inside Messages.tsx at lines 52–53 and 1227–1569, the basis for Decision 1 (calls ride with conversation-chat, no extra ledger row); (2) every listed chat/call hook runtime-imports @/integrations/supabase/client.ts, the basis for Decision 2 (core purity rule); (3) the exact 9 parity-ledger rows partitioned 3+6; (4) parity-ledger.mjs:60 shapeOf matching logic driving the four exclusion-route status flips; (5) App.tsx:1352–1410 route lines. The sibling plan (native-wave2-home-feed-news) established a precedent that the converging sparring session also could not read vitana-v1, which VTID-05253 acknowledged as an unmet gate form — this plan is now repeating that pattern for a second batch.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:332` — session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText }); // no extra_refs: vitana-v1 access not forwarded
- `exafyltd/vitana-platform:docs/validation/VTID-05253/vitana-v1-spar-evidence.md:13` — The session that actually *converged* this plan (`8e2ff780`) was created before the ref fix was in the plan branch's base checkout, so in that converging round the sparring partner could not `read_file` vitana-v1. The pure 'the converging sparring session read vitana-v1' form of the gate was therefore not met by that session. What satisfies the gate instead (the stronger, practical form). Every implementation lane behind this sentinel was built and reviewed against the real vitana-v1 code

Suggestion: Resolve R1-F1 to gain vitana-v1 access, then re-run sparring so premises (1)–(5) can be verified directly. As an interim measure following the VTID-05253 precedent, the planner must attach file excerpts (path, line range, quoted content) from the vitana-v1 worktree for each premise to handoff.md, and the lane reviewer must be contractually required to re-verify them during implementation PR review rather than deferring entirely to implementer trust.

### R2-F1 [major]

plan-spar.mjs has a structural gap: extra_refs is computed at the top of step() from handoff.md's spar_refs on every run, but it is only consumed in the client.create() branch (lines 312–320). The client.round() call at line 333 never includes it. This means any cross-repo plan where spar_refs is added after the first session is created will silently lose companion repo access for all subsequent rounds. The extraRefs variable is simply never referenced in the round branch. This is not specific to this plan — it will affect every future native wave 2 plan that discovers the access gap in Round 1 and adds spar_refs in response.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const handoffForRefs = path.join(spec, 'handoff.md'); const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : []; let extraRefs; for (const [r, ref] of declared) { if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(...); (extraRefs ??= {})[r] = await resolveRef(r, ref, ...); }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:312` — client.create({ ..., ...(extraRefs ? { extra_refs: extraRefs } : {}), }) ... client.round(cur.id, n + 1, { responses: ..., revised_plan_text: planText }) — extraRefs not spread into round body

Suggestion: Change the client.round() call at line 333 to: `{ responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText, ...(extraRefs ? { extra_refs: extraRefs } : {}) }`. The gateway already re-validates extra_refs keys against PLAN_SPARRING_REPOS server-side, so forwarding them on every round is safe. If the gateway already stores extra_refs at the session level, this change is a no-op for sessions created with the ref and a fix only for sessions that gain spar_refs mid-flight.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — The planner's rejection is sound on the mechanism point. plan-spar.mjs lines 286–293 confirm that companion-repo forwarding is driven exclusively by spar_refs in handoff.md, not by any repo declaration in plan.md. The plan.md header is documentation convention only and carries no infrastructure effect. The predecessor plan.md lines 1–5 confirm the repo-declaration convention exists, but whether the current plan.md follows it cannot be verified at the pinned base commit (the spec folder is absent there). Acknowledged — the mechanism argument is correct.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
