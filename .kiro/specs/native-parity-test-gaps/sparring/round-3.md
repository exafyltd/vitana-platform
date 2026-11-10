# Sparring round 3 — escalated

Session: `17092071-449c-4b3b-a7d5-d3f3166a9b12` · plan hash `91d285f68451a955d4d16747c041d8eca13102dcb370e3b032d671b2989e0ced`

## Summary

Round 3. The planner accepted R2-F1 and declared spar_refs in handoff.md. However, vitana-v1 is still inaccessible (confirmed: read_file returns "no pinned ref"). The reason is structural: `extra_refs` is only forwarded at `client.create()` (plan-spar.mjs line 319), never at `client.round()` (line 333). Since this sparring session was already created in round 1 — before spar_refs was declared — the companion ref was never sent to the gateway. Adding spar_refs to handoff.md cannot retroactively inject refs into an existing in-progress session. All nine vitana-v1 premises remain unverifiable by this sparring partner across three rounds. The plan itself is low-risk (tests-only, no source or ledger changes), and wrong premises would self-correct via failing tests, but the sparring mandate of at least 3 premises verified via read_file has not been met. This is re-raised as a finding.

## Findings

### R3-F1 [blocker]

Accepted fix for R2-F1 is structurally ineffective: spar_refs in handoff.md only takes effect at session creation, not mid-session. `extra_refs` is forwarded only in `client.create()` (line 319); `client.round()` (line 333) sends only `{ responses, revised_plan_text }`. This session was created in round 1 before spar_refs was declared, so the gateway never received the companion ref. vitana-v1 remains unpinned (confirmed: read_file returns 'no pinned ref for exafyltd/vitana-v1 in this session'). All vitana-v1 premises — intents/mine.tsx content, my-groups/[id].tsx content, resolve.ts NATIVE_ROUTES/NATIVE_PATTERNS, ledger.json rows, jest.config.js roots, test helper availability, absence of existing tests, parity-ledger.mjs output — remain unverified across three rounds. The sparring mandate requires at least 3 premises verified with read_file; zero are verifiable.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:312` — session = await client.create({ plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY, ...(extraRefs ? { extra_refs: extraRefs } : {}), });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:332` — action = 'round'; session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const handoffForRefs = path.join(spec, 'handoff.md'); const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : []; let extraRefs; for (const [r, ref] of declared) { if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(`spar_refs: ${r} is not an allowed sparring repo`); if (r === repo) throw new Usage(`spar_refs: ${r} is the plan's own repo; it is pinned by --base-sha`); (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl }); }

Suggestion: The spar_refs mechanism is correct for future plans but cannot be applied retroactively to this in-progress session. The only remedies are: (1) escalate this session so the planner can replan (plan-spar.mjs line 307: replan triggers a new `client.create()` which WILL forward extra_refs), allowing a fresh session with vitana-v1 pinned from the start; or (2) accept that this plan's vitana-v1 premises are verified only by the evidence.md secondary artifact and the self-correcting nature of the tests (wrong premises → failing tests at build time), and explicitly document this exception. Option (1) is the clean path; option (2) is pragmatic for a tests-only, no-source-change plan.

## Acknowledgements of earlier responses

- R2-F1: disputed — The planner accepted the fix and declared spar_refs in handoff.md, which is the correct mechanism for NEW sessions. However, the fix is structurally ineffective for this already-in-progress session: extra_refs is only forwarded at client.create() (plan-spar.mjs:319), never at client.round() (plan-spar.mjs:333). Since the session was created in round 1 before spar_refs was declared, the gateway never received the companion ref. vitana-v1 remains unpinned (confirmed by read_file returning 'no pinned ref'). Re-raised as R3-F1 with the structural explanation and two remediation options.
