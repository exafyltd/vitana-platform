# VTID-05658 — client-identity-store acceptance
Change types: Backend, Database, Tooling/docs

Outcome: the gateway echoes the request's client class on every response and records, once per member, class and day, that a native or web client was seen; an adoption query reads those facts.
States: native and web header; no identity; user or tenant null; write failure; new UTC day; native-only, Appilix-only, both, plain-web members.
Surfaces: services/gateway/src/middleware/client-identity.ts, services/gateway/src/services/client-adoption/**, supabase/migrations/20261108150000_client_identity_daily_seen.sql (file only, not applied).
Locales: n/a. Accessibility: n/a.
Staging proof: read-only unauthenticated probe, see staging-tests.json. Depends on #4917 (classify module); typecheck and Jest on main are green only after it merges.

AC-1 — the middleware sets X-Vitana-Client-Class (native or web) before next() and never fails a request
  TEST: services/gateway/test/client-adoption-middleware.test.ts (echo before next, failing and throwing writers)

AC-2 — a daily-seen row is written once per (day, tenant, member, class) and only with a non-null user and tenant
  TEST: services/gateway/test/client-adoption-middleware.test.ts (no write without identity, null user or tenant, one upsert per day, new-day write)

AC-3 — the adoption query is read-only, returns aggregates only and counts native-only, Appilix-only, both and plain-web members
  TEST: services/gateway/test/client-adoption-query.test.ts (classification, counts, empty window, read-only SQL)

AC-4 — the migration has a four-column primary key, tenant_id, RLS on with no policy and a 35-day purge; it is not applied by this change
  TEST: services/gateway/test/client-adoption-query.test.ts (migration shape)
