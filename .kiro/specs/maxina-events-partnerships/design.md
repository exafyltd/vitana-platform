# Design

The native VITANALAND calendar is the only store of event data. It holds drafts and published snapshots. No external calendar is read, written or synchronised.

State model: `draft` → `published` → `withdrawn`. A draft is visible only to editors. Publishing stores a snapshot of the partner fields and makes the event visible to invited partners. Withdrawing removes partner visibility and keeps the record for editors. Internal fields (notes, tentative status, logistics) are never part of the snapshot or any partner response.

Access: editors are team roles. Partners are invited accounts. Every read and write resolves identity on the gateway and checks role, invitation status and tenant on each request. A revoked invitation fails on the next request. Unpublished events and other partners' proposals return not-found.

Proposals: created by a `POST` that carries a client-generated idempotency key, stored with a unique constraint on (partner, key). The response confirms only after the row is committed. The client keeps the draft until it receives success.

Frontend: branded `/maxina/events` route in `src/App.tsx`. Event deep links preserve the target through sign-in. List and month views share one data source. Explicit localised dates; a contribution deadline is shown separately from the event date. Loading, empty and error states are provided. Commerce links to the same route.

API payloads, tenant isolation, and the migration approval path are established during PLAN-SPAR.
