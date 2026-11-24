# Design

Use the public route position in `src/App.tsx` for the branded sign-in and invitation state. Authorize event reads and proposal sends on the gateway. The app accepts a published event ID for deep links. The frontend uses an explicit localized date for each event and an independent contribution deadline. Provide loading, empty and error states.

An event editor enters approved partner fields from the private calendar, previews them, and publishes or withdraws the partner entry. Publish only date, location, category, title, cleared image, contribution needs and deadline by default. Proposal review is editor-only. The submitted record is created before showing its confirmation.

Scope event and partner roles specifically to this feature. Keep calendar sync out of the first release. Establish API payloads, tenant isolation and migration approval path during PLAN-SPAR.
