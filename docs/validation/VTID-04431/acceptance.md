# VTID-04431 — past resolved tickets inform the drafters

Phase 4 follow-up of `docs/MEMORY-SYSTEM-PLAN.md`. VTID-04412 writes a
`role:support` copy of every resolved ticket into `memory_items`; nothing read
it. This adds the staff-side reader.

## Acceptance

AC-1: `support_resolution_search` searches only `support_ticket` rows with `active_role='support'` in ONE tenant, excludes the current ticket, and returns ticket ids and similarity only — never episode text. `service_role` only; `anon` and `authenticated` cannot execute it.
TEST: live privilege check recorded in outputs/live-db-verification.md (applied live before merge).

AC-2: `findSimilarResolvedTickets` resolves the ticket's reporter tenant, embeds the report with the memory embedder (Titan V2), calls the RPC, and returns up to three resolved/user_confirmed tickets with their published resolution, best match first.
TEST: services/gateway/test/vtid-04431-prior-resolutions.test.ts

AC-3: another member's report text, name or transcript never reaches the drafter; only ticket number, kind and resolution do.
TEST: services/gateway/test/vtid-04431-prior-resolutions.test.ts ("never carries another member's report text")

AC-4: best effort and bounded — flag off (`SUPPORT_PRIOR_RESOLUTIONS_ENABLED=false`), no tenant, a failed embedding, an RPC error, empty text or no Supabase all return `[]`; the whole lookup is capped at 4 s. The draft is never blocked.
TEST: services/gateway/test/vtid-04431-prior-resolutions.test.ts

AC-5: the Sage, Devon and Mira drafters append a reference-only block ("do not quote them, do not mention other tickets or other members"); an empty list leaves the prompt unchanged. Drafts stay human-reviewed before a member sees anything.
TEST: services/gateway/test/vtid-04431-prior-resolutions.test.ts
TEST: services/gateway/test/vtid-04384-feedback-answer-drafter.test.ts
TEST: services/gateway/test/vtid-04311-feedback-spec-drafter.test.ts

## Not verified live

No `support_ticket` rows exist yet (0 at 2026-09-23, VTID-04412 is not deployed), and the 5 resolved tickets carry no resolution text, so there is nothing to backfill. The first real signal is a drafted answer on staging after a resolved ticket has been embedded.
