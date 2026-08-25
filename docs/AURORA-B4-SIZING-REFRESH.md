# B4 — Sizing Refresh (VTID-03739)

**This is not a B4 execution pass.** B4 ("Identity — the hard one") remains
explicitly out of scope for this session: it is the plan's own designated
schedule-risk workstream — credential migration off GoTrue plus rewriting
or re-grounding hundreds of RLS policies is not a task to execute from a
static-analysis pass, and getting it wrong "locks out every user or,
worse, silently breaks tenant isolation" per the plan's own words. This is
a short, live-verified refresh of B4's sizing numbers only, done for the
same reason B2/B5/B6/B7 got the same treatment: to confirm whoever picks up
B4 execution is scoping against current reality, not the numbers the plan
was written with.

## Live numbers vs. the plan's, all three grown

| Metric | Plan's figure | Live (2026-08-25, project `inmkhvwdcuyhnxkgfvsb`) | Delta |
|---|---|---|---|
| `auth.users` row count | 199 | **205** | +6 |
| `public` schema RLS policies referencing `auth.uid()` (`qual`/`with_check` ILIKE) | 557 | **635** | +78 |
| Frontend `supabase.auth.*` call sites (`exafyltd/vitana-v1/src`, excluding tests) | 194 | **205** | +11 |

For reference, `public` schema has 1,030 RLS policies total — the 635
referencing `auth.uid()` are 62% of all policies, consistent with the
plan's framing that this is the mechanism holding tenant isolation together
across the vast majority of the schema.

## What this does and doesn't mean

None of these deltas are alarming in isolation — a live platform gains
users and ships new tables/features continuously, so upward drift between
"when the plan was written" and "today" is expected, not a red flag. The
useful signal is the **direction and rough magnitude**: every one of the
three numbers grew, none shrank, and the RLS-policy count grew
disproportionately (+14%) relative to the user count (+3%) — consistent
with ongoing feature work adding new `auth.uid()`-gated tables faster than
the user base grows, which is exactly the trend that makes B4 more
expensive the longer it's deferred, not less.

**Not done here, deliberately:** verifying the plan's proposed mechanism
(a compatible `auth.uid()` SQL function in Aurora, reading from a
per-connection session GUC, so the 635 policies port unchanged instead of
needing individual rewrites) actually works against Aurora — that requires
write access to Aurora this session's read-only boundary does not have
(see `docs/AURORA-PHASE0-RECONCILIATION-FINDINGS.md`'s Access Boundary
section), and is real engineering work regardless, not something a sizing
pass should attempt to shortcut.
