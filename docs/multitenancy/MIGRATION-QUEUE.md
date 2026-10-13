# Multi-tenant program — migration queue

Every migration of the multi-tenant program (Track S security fixes and the
M0 lanes) in apply order. Timestamps are fixed per lane so the order is
mechanical; nothing here is applied by merging — each file goes through
`RUN-MIGRATION.yml` with its own read-only pre/post checks and owner approval.

| Order | Migration | VTID | Lane | Depends on | Pre/post checks | Status |
|---|---|---|---|---|---|---|
| 1 | `supabase/migrations/20261013233000_vtid_05147_s_m_membership_role_lockdown.sql` | VTID-05147 | Track S / S-M (security, ships first) | — | `docs/validation/VTID-05147/pre-apply-checks.sql` (STOP section re-run after apply), `post-apply-checks.sql`; rollback `rollback-s-m.sql` (re-opens the hole, owner approval) | committed, NOT applied |
