# Tasks

<!-- lane: partner-data -->
## Partner data and access

Build the migration and gateway API for the native event calendar: drafts, editor preview, publish and withdraw with the approved-field snapshot, invited-partner reads, proposal submission with idempotency, and team review with status updates.

### Acceptance

- Editors can create drafts, preview, publish and withdraw. Partner reads return only published snapshots.
- Invited, revoked, unrelated and editor identities are exercised, including direct requests for drafts, withdrawn events and other partners' proposals.
- A replayed proposal with the same idempotency key produces exactly one record. Malformed input and submissions to closed events are rejected.
- No Google Calendar identifiers, credentials or sync code are present.
- Staging verification uses isolated fixtures. The migration is listed for human approval before application.

<!-- lane: partner-web -->
## Partner web page and team tools

Build the branded `/maxina/events` route, the Commerce entry link, list and month views, filters, event details, the proposal form, and the editor views for preview, publish, withdraw and proposal review, all against the approved API.

### Acceptance

- The official logo and cleared event photos appear in responsive layouts on desktop and phone. Date browsing, filters, deep links and keyboard access work.
- A forwarded link preserves the target through sign-in. Missing and revoked access are handled with a clear state.
- The proposal form validates input, shows confirmation only after server success, and keeps the draft on recoverable errors.
- Staging evidence uses the exact landed frontend commit.
