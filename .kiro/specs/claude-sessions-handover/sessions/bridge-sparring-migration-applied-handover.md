# D - Bridge-period migration found live in production, file still says NOT APPLIED (session kiro-exafyltd-202611122052-a6df)
- Created 2026-11-13; read-only finding, no code/behavior change. Both repos not involved — vitana-platform only.

## Goal
STOP-FIRST safety check requested by the owner (GitLab migration delivery pipeline task): confirm whether any
`claude-agent migrate-supabase-forward` GitLab job (pipelines 322-329, failures since 08:41Z) reached a production
database, and which host it targeted.

## What I could not check
GitLab access from this session is blocked for every single-resource call (project/pipeline/job/branch lookups
all 403 `resource match not found`, confirmed again on `projects/2/pipelines/322` directly) — only the bulk
`projects?membership=true` list and `user` endpoints work. **I cannot see pipelines 322-329, their logs, their
variables, or their connection host, and I cannot cancel anything on GitLab.** This part of the STOP-FIRST ask is
unresolved from this session.

## What I found instead, independently, read-only (Supabase MCP, no GitLab)
Checking production directly as a second, independent signal: `supabase/migrations/20261112100000_bridge_sparring_convergence_is_approval.sql`
is marked in its own header **"NOT APPLIED... apply only after the owner approves this file"**, and this
session's own earlier work today (VTID-05785, merged as platform PR #5057) repeatedly treated it as unapplied
across its acceptance criteria, scope.json and multiple AI review rounds (`docs/validation/VTID-05785/`).

**It is applied.** Three independent checks on project `inmkhvwdcuyhnxkgfvsb` (the only Supabase project visible,
host `db.inmkhvwdcuyhnxkgfvsb.supabase.co` — this IS the production database, shared with staging):
1. `version = '20261112100000'` is present in `supabase_migrations.schema_migrations` (count 1).
2. The live `public._plan_sparring_gate_eval` function body (`pg_get_functiondef`) matches this migration's
   `ELSIF v_s.verdict <> 'converged' THEN v_reason := 'not_converged';` branch exactly — not the prior
   `20261015180000` migration's `ELSIF v_s.human_approved_by IS NULL AND NOT (v_s.policy_approved_at IS NOT NULL
   AND v_s.verdict = 'converged') THEN` branch. The two migrations' bodies genuinely differ at this line; the live
   one is the newer (bridge-period) text, not the older one.
3. GitHub `RUN-MIGRATION.yml` run [43258498678](https://github.com/exafyltd/vitana-platform/actions/runs/43258498678)
   (`workflow_dispatch`, actor `exafyltd`, 2026-11-12T16:25:46Z, **success**) shows in its own log:
   `MIGRATION_FILE: supabase/migrations/20261112100000_bridge_sparring_convergence_is_approval.sql`, `Applying SQL
   file: ... (project inmkhvwdcuyhnxkgfvsb)`, `Recorded in supabase_migrations.schema_migrations`.

**This is NOT the GitLab `claude-agent migrate-supabase-forward` mechanism the owner asked about** — it's GitHub's
normal `RUN-MIGRATION.yml`, the sanctioned path under `collaboration.md` §7d, dispatched by the shared `exafyltd`
GitHub identity (every Kiro seat uses it; the actor field alone can't say which seat or session). I have no
visibility into whether the owner actually approved this file before that dispatch (that conversation, if it
happened, is in a session I can't see) — I'm not alleging it was unauthorized, only that a migration marked
"NOT APPLIED" in the repo **is live**, and nothing in this session re-confirmed the owner's approval for it.

**Checked for actual impact — found none so far.** The relaxed check means a converged session with neither
`human_approved_by` nor `policy_approved_at` set could now pass the gate. I queried every `plan_sparring_sessions`
row with a `vtid` set, created after 2026-11-12 (when this went live): all 4 (VTID-05788, 05785, 05780, 05778)
have `policy_approved_at` set and `approval_policy='converged-auto-v1'` — the gateway's own TypeScript still sets
real policy approval before every real request reaches this function, so the gap exists in the DB's own
defense-in-depth but nothing has walked through it via the normal application path, as far as this session's
read-only check can tell. I did not check for a direct, out-of-band `vtid_ledger` insert bypassing the gateway
entirely.

Checked whether this is systemic: `grep -l "NOT APPLIED" supabase/migrations/*.sql` found 4 other files making the
same claim (VTID-03834, VTID-03842, VTID-04446, VTID-04909). None of those 4 versions appear in
`schema_migrations` — only this one migration is affected.

## Blocked on / needs owner
1. **Did you (the owner) approve applying `20261112100000_bridge_sparring_convergence_is_approval.sql`?** If yes:
   the file's own "NOT APPLIED" header is now stale and misleading — worth a follow-up PR to fix the comment so
   the next session doesn't repeat the same false premise VTID-05785's evidence built on. If no: this function's
   approval check has been live and relaxed since 2026-11-12T16:25:46Z with no record of your approval that this
   session can find — worth deciding whether to revert it (a new migration restoring the `20261015180000` check)
   or formally accept the bridge-period behavior as intended.
2. **The GitLab side is still completely unanswered.** I have no way to confirm or deny whether a
   `claude-agent migrate-supabase-forward` job (pipelines 322-329) ran against this or any other database, or
   cancel one if it's running — GitLab single-resource access is blocked for this session (separate finding,
   reported elsewhere this session).

## Next steps for Kiro
- Do not apply or revert anything without the owner's answer to question 1.
- If GitLab access is restored for this session, check pipelines 322-329 directly for the
  `claude-agent migrate-supabase-forward` jobs and their target host, per the original ask.
- If the owner confirms this migration was NOT approved, treat it as a live production change needing a decision
  (revert vs. accept), not routine cleanup.

## Gotchas/lessons
- A migration file's own "NOT APPLIED" comment is not proof it wasn't applied — checking `schema_migrations` and
  the live `pg_get_functiondef` directly is the only reliable signal, independent of what any session (including
  this one, earlier today) assumed from the file text.
- `RUN-MIGRATION.yml`'s `actor`/`triggering_actor` is always the shared `exafyltd` GitHub identity for every Kiro
  seat — it cannot identify which seat or session dispatched a run.
