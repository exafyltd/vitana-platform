# Sparring round 1 — in_progress

Session: `185a911c-d850-4c75-bdd6-89c59beb4e3a` · plan hash `8082ef945073212e56807c43796e7568f6bc3e8c15f3ac7d79ec908369d21324`

## Summary

I verified the plan's premises against the pinned commit of vitana-platform. Two key factual citations are wrong or unverifiable: (1) the CLAUDE.md rule number cited for the single-Supabase-project constraint is incorrect, and (2) the vitana-v1 extra_refs fix claimed as "merged to main" is not present in the pinned code, leaving all native-code file:line premises unverifiable in this session. The MOBILE-DEVICE-E2E.yml and handoff.md premises hold as stated.

## Findings

### R1-F1 [major]

The plan cites 'CLAUDE.md rule 31 (VTID-03506)' as stating 'There is exactly one Supabase project and every frontend (incl. preview/staging) writes to it.' In reality, CLAUDE.md rule 31 (lines 756-760) is about Bedrock unconfigured behaviour: 'IF Bedrock is unconfigured (BEDROCK_ROLE_ARN unset) → THEN the adapter reports not_configured and the router SKIPS it.' The single-Supabase-project fact does exist in the codebase (handoff.md line 100: 'the staging frontend uses the production Supabase'), but it is NOT rule 31 and its VTID is not VTID-03506. A plan whose safety argument ('never points any build at production or staging') rests on a mis-cited governance rule should correct the citation before implementation.

- `exafyltd/vitana-platform:CLAUDE.md:756` — 31. **IF** Bedrock is unconfigured (`BEDROCK_ROLE_ARN` unset) → **THEN the adapter reports `not_configured` and the router SKIPS it.** Flipping routing to `bedrock` before that var is set does not fail loudly — it quietly serves the fallback instead. Configure and verify Bedrock FIRST, then flip routing. Never the other way round.
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:100` — Never test against production; staging specs are read-only; the staging frontend uses the production Supabase.

Suggestion: Find the correct rule number and VTID for the single-Supabase-project constraint (it may be in §3 of backend.md or infrastructure.md under a different rule number). The safety argument itself is sound — production and staging share one database — but the evidence trail must cite the right source. Search for 'VTID-03506' to locate the actual rule it belongs to.

### R1-F2 [major]

The plan declares `spar-vitana-v1-ref` as 'RESOLVED, merged to main' and states that this fresh session can now read vitana-v1 files. However, at the pinned commit (7b6425b) the `plan-spar.mjs` `client.create` call (lines 192-194) sends `{ plan_text, producer, change_class, base_ref, repo, approval_policy }` with NO `extra_refs` parameter. PLAN-SPAR.yml (lines 80-82) likewise does not resolve a vitana-v1 SHA or pass any extra ref to the script. Attempts to read vitana-v1 files in this session returned 'no pinned ref for exafyltd/vitana-v1 in this session', confirming the fix is not live at this pin. Every vitana-v1 file:line premise in the plan (env.ts production guards, push provider injection, app.config.ts APP_PROFILE, orb-fake-gateway structure, parity ledger stats, etc.) is therefore unverifiable by the sparring partner.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — session = await client.create({
  plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
});
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:80` — git -C head diff --name-only "$BASE_SHA"...HEAD > "$RUNNER_TEMP/changed.txt"
node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" \
  --changed "$RUNNER_TEMP/changed.txt" --summary "$GITHUB_STEP_SUMMARY"

Suggestion: The plan cannot claim the lane is resolved until the fix is verifiably present at the session's pinned commit. Either re-pin this sparring session to a commit that includes the extra_refs fix so vitana-v1 premises can be verified, or do not mark the lane as resolved — the plan should remain at 'approved→executing blocked on spar-vitana-v1-ref' rather than claiming a resolution that the partner cannot confirm. The dozen-plus vitana-v1 file:line citations (env.ts:82, :105, :189; push/provider.ts:52; app.config.ts:36; tools/orb-fake-gateway/server.js:1; etc.) are the foundation of the design decisions and cannot be taken on trust.

### R1-F3 [minor]

The plan's Decisions section cites `design.md §2`, `§3`, `§4`, `§5`, `§6` roughly ten times as the sole grounding for each decision. Those sections live in `.kiro/specs/native-g1-wiring/design.md`, which does not exist at the pinned commit because PLAN-SPAR runs against the base branch and the spec is authored in the PR head. Per the collaboration protocol, the sparring partner reads the base branch as trusted code and the PR head only as data. Since design.md is data (PR head) and not verifiable by read_file against the base, every decision that is only grounded in design.md — rather than in actual code — is unconfirmable by the partner.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:9` — Security: `pull_request_target` runs THIS file from the base branch, and scripts/collab/plan-spar.mjs is run from the base checkout. The PR head is checked out only as data (read files, write the round files, push them back) — nothing from the PR is executed while the token is in the environment.
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:70` — `native-g1-wiring` — point dev/QA builds at the G1 test backend once it exists (env profiles, EAS profiles); until then, fake-gateway / fixture tests only. Wave 1 exit: signed-in G1 member navigates the full shell, gets a push and opens its deep link on both platforms.

Suggestion: For each decision grounded only in design.md, inline the key factual claim directly into plan.md with a code citation the partner can verify. Decisions 1–5 each have a rejected alternative; the rationale for the rejection should cite the actual code (e.g. env.ts line numbers, provider.ts injection point) rather than a section of a file the partner cannot read. This is partially moot if R1-F2 is resolved (once vitana-v1 is pinned the env.ts/provider.ts cites become checkable), but design.md itself will still be unreadable.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
