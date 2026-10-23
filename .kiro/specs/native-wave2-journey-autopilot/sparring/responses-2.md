```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct and verified against the pipeline code. spar_refs is only applied at client.create (scripts/collab/plan-spar.mjs:313-320, inside the `!cur || retryInfra || replan` branch); an in_progress session takes the client.round path (plan-spar.mjs:322-335) which forwards no extra_refs, and the gateway pins repo_refs from the round-1 session record, created before spar_refs existed. So this session can never acquire exafyltd/vitana-v1 read access by answering another round — the fix is a FRESH client.create that picks up `spar_refs: - exafyltd/vitana-v1: main` from handoff.md. The reachable recovery path for this non-infra session is the `replan` branch (plan-spar.mjs:307): once this session's verdict is `escalated` and the plan text has changed, the next PLAN-SPAR run creates session #2 (state.sessions.length 1 < MAX_SESSIONS 2) with extra_refs applied. This commit changes the plan text (adds a Cross-repo sparring section and a Sparring status note) precisely so that, as soon as this session escalates at the round cap, the plan-text-change condition for replan is already satisfied and the fresh session is created with vitana-v1 pinned. No plan-logic defect is implied by this finding; it is a sparring-infrastructure limitation of the round-1 session.",
    "deferred_to": ""
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Accepted as the consequence of R2-F1: the IO-free (class A) classification of src/lib/horizonBuckets.ts and src/lib/vitana-projection.ts, the packages/core/manifest.json autopilot type re-export, and every apps/mobile/** assertion remain independently unverified because the partner cannot read exafyltd/vitana-v1 in this session (scripts/native/core-closure.mjs, parity-ledger.mjs and parity-scope.json also live in vitana-v1, not vitana-platform). These are the exact checks the fresh, vitana-v1-pinned session must perform and cite: read both helpers in full to confirm no runtime import of @/integrations/supabase/client or @/lib/community-gateway (the post-attachment.ts failure mode), and read packages/core/manifest.json to confirm the src/types/autopilot.ts type re-export entry. The plan already classifies both helpers as class A / extractable and treats every hook/provider as class B (re-implemented, never extracted); no plan edit changes that classification — the next session verifies it against the now-readable source.",
    "deferred_to": "fresh vitana-v1-pinned sparring session (replan branch) — flagged for owner/operator if replan does not auto-fire"
  }
]
```

<!-- re-spar trigger 2026-10-23T08:15:44.3328326+02:00 -->
