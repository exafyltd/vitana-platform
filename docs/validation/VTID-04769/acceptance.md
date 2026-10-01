# VTID-04769 — a supplier that goes live appears on Discover

Owner request, 2026-10-01: everyone who registers through Commerce should show
up in the part of Discover that applies to them. Step A of the plan agreed in
session: going live switches the business's products on. Owner confirmed that
the Vitanaland team's **Activate** click is the go-live point for now (the
Commerce sign-up never calls the self-service submit step).

## Acceptance criteria

| # | Criterion | Proven by |
|---|---|---|
| AC-1 | When an org reaches `live` (incl. the legacy `POST /partner-orgs/:id/activate`), its waiting products go on | scenarios "go-live: …", "team Activate: hand product on Discover" |
| AC-2 | A product added while the org is live goes on at once; while not live it waits | "insert while live: on", "insert while not live: off, waiting" |
| AC-3 | Pause/suspend hide the org's products; returning to live restores them | "pause: …", "resume: …", "suspend: hidden" |
| AC-4 | An admin switch-off is never undone; an admin switch-on while not live is held until live | "admin switch-off …", "admin switch-on while paused: held", "resume: admin-off stays off" |
| AC-5 | Test and service accounts never list, and registering one later takes its products down | "test owner: …", "service-account merchant product never on" |
| AC-6 | Network products (Awin etc.) are never read or written | "backfill: network …", "network admin switch-on" |
| AC-7 | Products added by hand (owner-keyed merchant) follow the owner's single org, never guessed | "hand merchant linked …", "earlier hand merchant adopted …", "two orgs: not linked", "second not linked" |
| AC-8 | The migration is re-runnable | "re-run: …" |

## Evidence

- `migration-scenarios.sql` — 41 scenarios against stub tables, run on a
  throwaway local PostgreSQL 16 (never a shared database). Output:
  `outputs/migration-scenarios-postgres16.txt`, all `ok`, `ALL PASSED`.
- `services/gateway/test/vtid-04769-supplier-go-live-listing.test.ts` pins the
  invariants in the migration text (Gateway Jest in CI).

## Not done here

- **Not applied.** Applying the migration to the production database needs the
  owner's explicit go-ahead after this PR is reviewed.
- Category mapping to Discover sections (step B) and a business listing in
  Discover (step C) are separate VTIDs.
- Commerce Portal copy still says products "go live after review"; it is
  updated in vitana-v1 once this migration is applied, so the text never
  runs ahead of the behaviour.
