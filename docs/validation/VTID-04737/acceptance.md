# VTID-04737 — "Bist du noch da?" keeps the conversation open unless the member asked to stop

Ships with VTID-04736 in one PR; the production evidence, all three fixes and
the full test run are in `docs/validation/VTID-04736/`.

## Acceptance

AC-1: see VTID-04736 AC-3.
TEST: services/gateway/test/orb/live/session/still-here-complaint-backstop.test.ts
