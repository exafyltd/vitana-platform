# VTID-04439 — contacts import never fails a batch on an existing phone or member

The contacts import (VTID-04405) upserts on `(user_id, source, external_id)`.
But `contacts` has two older unique indexes, confirmed live (read-only
`pg_indexes`):

- `unique_user_phone (user_id, contact_phone)`
- `unique_user_contact (user_id, contact_user_id)`

The import did not account for them. Any of these made the whole batch fail,
and with it the Google, iCloud or Android sync:

- two contacts sharing a phone (a family landline);
- Google and iCloud both holding "Mom";
- a contact the member had added by hand.

**Fix:** `resolveCollisions()` is a pure function.

- It reads the member's rows that hold a phone or a member id, paged past
  PostgREST's 1000-row cap.
- It skips any incoming contact whose phone or member is already held by a
  different row: that is the same person, already in their contacts.
- A contact re-synced from its own source keeps what it holds.
- Skipped contacts are reported as `already_present`; `imported` and
  `on_platform` count only what was written.

AC-1: A phone that a hand-added contact holds, a phone repeated within one import, or a member reached from a second source is skipped, not failed.
TEST: test/vtid-04439-contacts-import-collisions.test.ts › resolveCollisions

AC-2: A contact re-synced from its own source keeps its phone and member.
TEST: test/vtid-04439-contacts-import-collisions.test.ts › resolveCollisions › a contact re-synced from its own source keeps its phone and member

AC-3: The import reads the member's existing keys, writes only the rows that are safe, and reports the rest.
TEST: test/vtid-04439-contacts-import-collisions.test.ts › importContacts

AC-4: The hub flows are unchanged (Android import, Google/iCloud sync).
TEST: test/vtid-04402-connected-apps.test.ts › toggle flows

OASIS_PROOF: no new event types. A sync that still fails emits the existing `connected_app.sync_failed`.

Not verified against a live import: no real Google or iCloud account is connected on staging, and writing contacts as the test account is forbidden.
