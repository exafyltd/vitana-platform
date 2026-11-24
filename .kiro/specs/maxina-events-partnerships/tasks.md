# Tasks

<!-- lane: partner-data -->
## Partner data and access

Build the gateway and persistence for event publishing, invited partner reads, contribution submission and team review.

### Acceptance

- Exercise invited, removed, unrelated and editor identities, including direct requests for unpublished events and other partners' proposals.
- A replay of a successfully submitted proposal produces only one record. Reject malformed and closed-event submissions.
- Stage verification uses isolated fixtures and documents the migration and configuration requirements.

<!-- lane: partner-web -->
## Partner web page and team tools

Build the branded route, Commerce link, list/month views, details, contribution form and team management views against the approved API.

### Acceptance

- The official logo and event photos appear in responsive layouts. Date browsing, filters, deep links and keyboard access work.
- The route preserves a deep link after sign-in. Missing and revoked access are handled. The editor can publish/withdraw an event and review received proposals.
- Proposal validation, error recovery, successful submission and unavailable events are covered. Staging evidence uses the exact landed frontend.
