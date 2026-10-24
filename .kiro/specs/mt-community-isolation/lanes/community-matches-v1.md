---
lane: community-matches-v1
state: ready
next_actor: owner
depends_on:
  - community-tenant-db
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - supabase/functions/generate-daily-matches/**
  - src/i18n/de/matches.json
  - src/i18n/en/matches.json
updated: 2026-10-15T16:30Z
---
# Daily matches — active-tenant candidate pool (CODE, dark) — mt-community-isolation/community-matches-v1 (repo vitana-v1)

HELD: `next_actor: owner`, no `vtid` until PLAN-SPAR converges and allocates it (then flips to
`kiro`). Plan: `../plan.md`; tasks/paths/acceptance: `../tasks.md`
(`<!-- lane: community-matches-v1 -->`); design: `../design.md`. **Repo: vitana-v1** (paths are
vitana-v1-relative; this lane's PR is opened in vitana-v1).

Behind `tenant_settings.feature_flags.mt.community_scope`, restricts `generate-daily-matches`
(`supabase/functions/generate-daily-matches/index.ts:110-153`) candidate pool to the viewer's active
tenant and writes the new `daily_matches` tenant column (added by `community-tenant-db`) on insert;
keeps the existing rule-45 test/service exclusion. With the flag off, pool is unchanged. Any new
user-visible string is DE-first du-form then mirrored to EN (`matches.json`); `match_reasons` stays
`{key, params}`.

Rules (§7a): no VTID allocation, no `_plan`/`handoff.md` edit, no merge/approve/deploy/dispatch, no
live writes (never run the edge function against production). Network scope and `network_visible` are
the sibling spec. Depends on `community-tenant-db` (the `daily_matches` tenant column; in-spec) and
WS1's resolver (external — stated here, not in `depends_on`). This lane adds its own
`docs/validation/<vtid>/` in vitana-v1.

Branch `kiro/mt-community-isolation/community-matches-v1`;
PR title `VTID-xxxxx (mt-community-isolation/community-matches-v1): …`; trailers
`Collab-Session`/`Collab-Lane: mt-community-isolation/community-matches-v1`. On PR open: `state:
in-review`, `next_actor: kiro`, `pr:`, log entry, release the claim.

## Log
### 2026-10-15T16:30Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted. HELD until PLAN-SPAR allocates the VTID.
