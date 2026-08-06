# "Aurora for everything, Supabase for auth only" — feasibility assessment

**VTID-03512** · 2026-08-05 · measured against production

User decision (2026-08-05), revising VTID-03494's Option B:

> supabase is replaced with aurora, except the auth — everything else should be
> aurora and no more supabase

This is a **narrower and better-shaped** target than full Option B: keeping
GoTrue removes the hardest workstream (migrating 201 users' credentials and
re-implementing identity). It is **not** the "hybrid" rejected in the earlier
plan — that was about dual-writing the *same* tables. This splits by
responsibility, which is a legitimate boundary.

But the split lands on a seam that is currently load-bearing, and three things
have to be decided before it can be scheduled.

---

## The blocker: 116 foreign keys into `auth.users`

Measured on production:

| | count |
|---|---|
| FKs from `public.*` → `auth.users` | **116** |
| distinct tables carrying one | **105** |
| FKs → `public.app_users` (the mirror) | 18 |
| rows in `auth.users` | 201 |
| rows in `public.app_users` | 194 |
| `app_users` rows with no `auth.users` row | 0 |
| **`auth.users` rows with no `app_users` row** | **7** |

If auth stays on Supabase and data moves to Aurora, **105 tables lose a foreign
key that Aurora cannot satisfy** — there is no `auth.users` there to point at.
That is the whole decision in one number.

There is already a mirror (`app_users`, referenced by CLAUDE.md as "the
canonical app_users mirror"), which is the shape of the answer — but it is
**7 rows behind today**. A mirror that silently drifts is exactly the failure
class of VTID-03480, and here it would mean users who can authenticate but own
no data.

### Three ways through, in preference order

**1. Promote `app_users` to the identity anchor (recommended).**
Repoint all 116 FKs from `auth.users` to `app_users`, move `app_users` to
Aurora with everything else, and make GoTrue→`app_users` the *only* thing
crossing the boundary. Requires: fixing the 7-row drift first, then a
guaranteed-delivery sync (a webhook or outbox, not a periodic reconcile), plus
a monitor that alarms on any drift — the lesson from VTID-03480.

**2. Drop the FKs, enforce in application code.**
Fast, and permanently loses database-level integrity on the most important
relationship in the system (every row → its owner). Given this codebase has
already accumulated 103 missing tables and a 7-row identity drift, removing a
constraint that currently *cannot* silently break is the wrong direction.

**3. Move auth too** — the original Option B. Rejected by this decision.

---

## Second problem: the frontend talks to Supabase directly

207 files in `vitana-v1/src` import Supabase, with 60 realtime `.channel()`
subscriptions and 19 storage calls. Those are **direct browser → Supabase**
data reads, not gateway calls.

Aurora has no PostgREST and is not internet-facing. So "all data in Aurora"
necessarily means **every one of those reads moves behind the gateway**. That
is a frontend workstream at least as large as the gateway one, and it is not
implied by the words "replace Supabase with Aurora" — worth being explicit
that it is in scope.

## Third problem: Realtime has no Aurora equivalent

Supabase Realtime works by reading the Supabase database's WAL. Move the tables
to Aurora and **Realtime sees nothing** — the 79 subscriptions across gateway
and frontend go silent. Retaining "Supabase for auth only" does not retain
Realtime, because Realtime is a function of where the *data* lives.

Replacement is a websocket service we own, fed by Aurora logical replication or
application-level publish. Sizeable, and easy to miss when scoping.

## What "auth only" does and does not keep

| stays on Supabase | must move / be rebuilt |
|---|---|
| GoTrue: signup, login, JWT issuance, sessions, password reset | PostgREST (2,461 gateway `.from()` calls) |
| `auth.users` and the 201 credentials | Realtime (79 subscriptions) |
| | Storage (23 call sites) |
| | 74 edge functions |
| | 925 RLS policies — 557 reference `auth.uid()` |
| | 116 FKs into `auth.users` |

### RLS is more tractable than it looks

The gateway uses the **service-role** client, so RLS is already bypassed for
every gateway query — those 925 policies protect the *frontend's* direct
access. Once the frontend goes through the gateway (forced by this
architecture anyway), the policies stop being the enforcement layer and the
gateway's own tenant scoping becomes it.

That is a real simplification — and a real risk. The tenant-isolation work in
VTID-03498 is a preview: with RLS bypassed, isolation is enforced *by code*,
which is why those repository functions take `tenantId` as a required first
parameter. Doing that consistently across 2,461 call sites is the actual
security task hiding inside this migration.

---

## Recommendation

The decision is sound and reduces scope versus Option B. Before it can be
scheduled, three answers are needed:

1. **FK strategy** — promote `app_users` to anchor (recommended), or drop the
   116 FKs? This shapes everything downstream.
2. **Is the frontend rewrite in scope?** "All data in Aurora" requires it;
   207 files, 60 realtime subscriptions, 19 storage calls.
3. **What replaces Realtime?** Nothing in "keep auth on Supabase" covers it.

And one thing to fix regardless of the answers, because it is a live bug:
**7 `auth.users` rows have no `app_users` row.** Whatever the identity anchor
ends up being, that drift should not be carried into a migration.

## Sequencing note

None of this blocks the B1 data-access seam (VTID-03498) already in flight.
B1 is transport-agnostic by construction: it moves queries behind repositories
that currently wrap supabase-js. Whether the adapter later points at Aurora,
or the frontend routes through the gateway, B1 is the prerequisite either way
and is safe to continue against the current stack.
