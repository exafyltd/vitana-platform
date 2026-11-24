# MAXINA Events & Partnerships
<!-- plan:begin -->
Add a branded MAXINA events page at `/maxina/events` in VITANALAND, with an entry link from Commerce that uses the existing `/commerce` code.

The native MAXINA event calendar inside VITANALAND is the single source of truth for every event. No Google Calendar is used: no calendar setup, no sharing, and no copying of event details between tools.

Editors are Jovana, Mariia and Dragan, granted editor access through VITANALAND team roles. The roster is configured at launch, not in the repository. Every event is created as a private draft. Editors can preview exactly what partners will see, publish the approved partner fields, and withdraw a published event. Internal notes, tentative status, private logistics and team discussion never leave the editor views.

Partner-visible fields, and only these, appear once an event is published: title, category, explicit local date and time, city or venue, cleared image with alt text, contribution needs, contribution deadline, and delivery requirements.

Partner access: invited associates, partners and sponsors sign in through the existing sign-in system. Access depends on an active invitation. A forwarded link does not grant access. A revoked partner loses access on the next request. A deep link to an event is preserved through sign-in.

Proposals: each eligible published event offers "Propose a contribution". Fields are organisation, work email, product or service, quantity or capacity, and delivery timing. The server saves the proposal before the confirmation is shown. A retry with the same idempotency key produces one record. Recoverable errors keep the draft. A partner sees only their own proposals. Editors see a team-only review queue and update proposal status.

Gateway and data lane owns the migration and API: event drafts and publications with a snapshot of the approved fields, editor and partner-access roles, proposal records with status and an idempotency key, and tenant-scoped row-level security. Every operation checks identity and permission on the server, validates input and is rate-limited. Migration application follows the repository migration gate and needs human approval. Verification uses isolated fixtures. Nothing is written to production.

Frontend lane owns the `src/App.tsx` route, the MAXINA events page (list and month views, filters for Let's Dance, Awards, Performances and Appearances), event detail deep links, the proposal form, editor preview, publish and withdraw views, the proposal review queue, and the Commerce entry. Reuse `public/images/maxina-logo.png`, app auth, translations and date helpers. Design for phone use from a forwarded WhatsApp link.

Verify with an editor, an invited partner, a revoked partner and an unrelated account. Confirm that a partner cannot see another partner's proposal and that draft events never reach partner APIs. Then run the staging verification flow on the landed commit.
<!-- plan:end -->
