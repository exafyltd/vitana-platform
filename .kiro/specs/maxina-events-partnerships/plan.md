# MAXINA Events & Partnerships
<!-- plan:begin -->
Add a branded partner calendar at `/maxina/events` on the existing VITANALAND frontend and a link from Commerce. The approved mock uses the MAXINA logo, a featured event, image-led event cards, category filters and list/month views.

Mariia, Dragan and Jovana use a dedicated private Google Calendar for working dates and notes. Authorized team members explicitly publish partner-ready fields through a team-only editor. Start with manual curation to keep the source calendar private and avoid granting app access to unrelated calendars. Set up the calendar with calendar-level editor rights for the three EXAFY accounts after Google sign-in is available.

The partner route can be opened from a forwarded link. Signed-in, explicitly invited associates, partners and sponsors can read approved event records and propose contributions. A forwarded link does not grant access. Every record displayed has an explicit publication decision. Show a branded invitation/sign-in state to other visitors. Keep editorial updates, notes and incoming proposal decisions in team-only views.

Gateway and data lane owns the migration and API: partner allowlist, editor membership, published event projection, proposal records and review states. Use server-resolved identity and permission checks on each operation, authenticated store access, validation and rate limits, and idempotent proposal creation. Never expose proposals to other partners or expose the private Google Calendar ID, credentials or details. Confirm existing auth and protected-route patterns in sparring. Dedicated event fields include date, venue/city, image and alt text, category, contribution needs and deadline. Avoid fixture records in deployed data. Migration application follows the repository migration gate.

Frontend lane owns `src/App.tsx`, an isolated MAXINA Events page, event/calendar view, proposal form, team controls and Commerce entry. Reuse `public/images/maxina-logo.png`, app auth, translations, locale and date helpers and same-origin gateway requests. Distinguish date and deadline, confirm proposals only after server success, preserve form state on recoverable errors and deep-link to an event. Use cleared event photography for publication.

Verify authorized editor, invited partner and unrelated account cases with local/isolated fixtures, then run the approved staging verification flow on the landed commit. Configure the final access roster and confirmed schedule ahead of partner launch.
<!-- plan:end -->
