# Sparring round 1 — in_progress

Session: `d6caa531-0937-42b4-a6c3-9085af2f4e46` · plan hash `4b34f59b342924ff37f18ec75deed678f78da0e10de931ecda392c1e7f4fb334`

## Summary

The plan is a governance-only text change with a generally coherent design, and most of its factual premises about the existing system hold (verify §7a/§7b merge prohibitions, the cutover_gate freezes, and the DEPLOY-CLOUDFLARE-WORKERS live-push risk). However, two substantive gaps remain. (1) The plan's central migration premise — "the only applier is RUN-MIGRATION.yml" — is false for vitana-v1, which applies production-database migrations through ~20 hardcoded `apply-*-migration.yml` workflow_dispatch workflows targeting a hardcoded production Supabase ref with no hash, no target input, and no MIGRATION_FREEZE; §7d B.6 therefore mechanises safeguards only for vitana-platform's RUN-MIGRATION.yml and leaves the real vitana-v1 production-migration path ungoverned. (2) CLAUDE.md's collaboration-roles paragraph still flatly states "Kiro never merges, deploys or writes to a live system," and the plan only says the paragraph "names §7d" without requiring that contradictory sentence to be amended/removed, so the merged text will contain two binding and mutually contradictory statements. Both should be fixed before implementation.

## Findings

### R1-F1 [major]

The plan's migration governance (B.6) is built on the false premise that RUN-MIGRATION.yml is the only migration applier. vitana-v1 applies production-database migrations through ~20 per-file `apply-*-migration.yml` workflow_dispatch workflows (e.g. apply-july-19-kira-ticket-price-migration.yml, apply-vtid-04955-group-participants-migration.yml, etc.) that POST hardcoded SQL to the production Supabase project ref using SUPABASE_ACCESS_TOKEN. These have no `target` input, no file-hash check, no MIGRATION_FREEZE guard, and no allow_non_transactional flag — none of the B.6 safeguards apply to them. §7d B.6 as written only names RUN-MIGRATION.yml, so the actual vitana-v1 production-migration path is left ungoverned by the new standing authority.

- `exafyltd/vitana-v1:.github/workflows/apply-july-19-kira-ticket-price-migration.yml:7` — on:
  # VTID-04949 (plan D2): no push trigger. Merging must never apply SQL to the
  # production database; migrations ship at Gate 2, dispatched in order.
  workflow_dispatch:
...
        PROJECT_REF: inmkhvwdcuyhnxkgfvsb
...
            SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
...
            ref = os.environ['PROJECT_REF']
            migration = 'supabase/migrations/20260703000000_fix_july_19_kira_ticket_price.sql'
- `exafyltd/vitana-v1:.github/workflows/supabase-functions-deploy.yml:1`

Suggestion: Extend §7d B.6 to cover vitana-v1's `apply-*.migration.yml` workflows explicitly: require the owner's per-file-and-target approval to name the specific workflow file and the SQL path, and (optionally) record a sha256 of the SQL file. Template the hardcoded PROJECT_REF out of the workflows or at minimum document that these are production applies governed by the same owner-only rule. Correct the plan's 'Today 3' premise to reflect that vitana-v1's applier is the per-file `apply-*.yml` set, not RUN-MIGRATION.yml.

### R1-F2 [major]

CLAUDE.md's collaboration roles paragraph (lines 121-125) flatly states 'Kiro never merges, deploys or writes to a live system,' and collaboration.md §7 (line 130) and §7 (lines 147-151) state the Project Manager / 'until it runs, Claude Code' merges and sets `verified`. The plan's Files section for CLAUDE.md says only that 'the collaboration roles paragraph names §7d' — it does not require amending or removing the flat 'Kiro never merges' sentence. The resulting merged text will contain two binding, mutually contradictory statements (Kiro never merges vs. §7d B.4 Kiro merges).

- `exafyltd/vitana-platform:CLAUDE.md:121` — the Project Manager merges by rule and sends Gate 2; Claude Code handles exceptions only
(governance-path lanes, unpicked or parked work, partner outages). Kiro never merges, deploys or writes to a live
system. See `.claude/rules/collaboration.md` §7–§7a.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:130` — **Kiro plans, builds and reviews; the Project Manager merges and sends Gate 2; Claude Code handles exceptions** ... → the Project Manager (until it runs, Claude Code) sets `verified` from an `approve` entry ... and merges ... Until it runs `live`, Claude Code merges a `verified` lane on the same rule.

Suggestion: Amend the CLAUDE.md roles paragraph so the flat 'Kiro never merges, deploys or writes to a live system' sentence is replaced with a pointer to §7d (e.g. 'Kiro merges/deploys only under §7d standing authority; production remains behind Gate 2'), and update the §7 heading/body merge references in collaboration.md to point at §7d, not just add pointer sentences that leave the old 'Project Manager / Claude Code merges' text as apparently-general.

### R1-F3 [minor]

The plan's B.4 staging-only check enumerates production push workflows whose push path is frozen by a cutover_gate as AUTO-DEPLOY.yml (platform) and DEPLOY.yml + supabase-functions-deploy.yml (vitana-v1). This omission of vitana-v1's AWS-PROD-DEPLOY-FRONTEND.yml is acceptable only because that workflow is workflow_dispatch-only (no push trigger), so it cannot fire from a merge; but the plan's Files/Tests structure check does not verify that the mechanical enumeration step will actually surface `apply-*.migration.yml` workflow_dispatch files as NOT push-triggered (they are harmless for B.4 but relevant for B.6).

- `exafyltd/vitana-v1:.github/workflows/AWS-PROD-DEPLOY-FRONTEND.yml:14` — workflow_dispatch ONLY, with a REQUIRED `reason` input — mirrors AWS-PROD-DEPLOY-GATEWAY.yml ... auto-deploy is for staging, prod is a deliberate action.

Suggestion: Minor: add a test-structure assertion that every workflow whose name starts with `apply-` in vitana-v1 is workflow_dispatch-only (no push) so the B.4 enumeration does not mis-categorise them; note they are production migration appliers governed by B.6 rather than deploy workflows.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
