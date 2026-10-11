## VTID-05063: task view sends the login token, stops polling on 401/403

Pairs with exafyltd/vitana-platform branch `VTID-05063-ledger-read-auth` (gateway ledger read gate, log mode first).

## Changes

- `src/lib/taskApi.ts`: task reads send the Supabase access token the way `adminFetch` does, skip the request when signed out, and return `access_denied` on 401/403.
- `src/hooks/useTaskStream.ts`: stops polling on denial.
- `src/components/dev/TasksView.tsx`: shows an access-denied notice.
- `src/i18n/*/screens.json`: new strings in all 11 locales.
- New `src/hooks/useTaskStream.vtid-05063.test.ts`.

## Testing

- `npx vitest run src/hooks/useTaskStream.vtid-05063.test.ts`: 9/9 pass locally.
- Full unit, build and lint run in CI.

## Notes

Safe to merge before or after the gateway PR: the gateway gate is in log mode in step A, and an authenticated read works both ways. Plan and sparring record: `docs/validation/VTID-05063/plan-sparring.md` in this PR.
