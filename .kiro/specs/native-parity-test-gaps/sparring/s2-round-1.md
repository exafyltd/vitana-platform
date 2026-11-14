# Sparring round 1 — in_progress

Session: `bfa2f63f-0937-44f0-b177-37897605efc1` · plan hash `76108d700c95b9e5f59d9afbf8ed2d68ae6287c6b64c62f7fa18f9434f44f600`

## Summary

The plan is well-scoped and most factual premises check out against the pinned code. The audit findings are accurate: both route files exist as described, the ledger rows match, `/intents/mine` is in `NATIVE_ROUTES`, `/comm/my-groups/:id` is correctly identified as missing from `NATIVE_ROUTES`/`NATIVE_PATTERNS`, and no existing test covers either route file. The jest config will pick up the new `tests/parity-gaps/` folder automatically. One material concern: the existing `community/mocks.ts` expo-router stub is incompatible with the test behaviours the plan describes, and the plan claims these helpers are "imported, not edited".

## Findings

### R1-F1 [major]

The plan says the new tests import the existing community/mocks.ts ("they are imported, not edited") and also says the intents/mine test uses a Redirect that "records its href" and the my-groups test uses useLocalSearchParams "returning an id". These are contradictory: community/mocks.ts stubs Redirect as () => null (no prop capture) and useLocalSearchParams as () => ({}) (empty object). Importing that mock file will override any test-file-level jest.mock for expo-router because Jest executes the imported module's jest.mock calls after the test file's hoisted ones. The tests as described cannot work by importing community/mocks.ts unedited.

- `exafyltd/vitana-v1:apps/mobile/tests/community/mocks.ts:26` — jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => ({}),
  usePathname: () => '/comm/groups',
  useGlobalSearchParams: () => ({}),
  Redirect: () => null,
}));
- `exafyltd/vitana-v1:apps/mobile/app/(app)/intents/mine.tsx:7` — import { Redirect } from 'expo-router';

export default function MyIntentsRoute() {
  return <Redirect href={'/comm/find-partner?view=posts' as never} />;
}
- `exafyltd/vitana-v1:apps/mobile/app/(app)/comm/my-groups/[id].tsx:6` — import { useLocalSearchParams } from 'expo-router';
import { GroupDetailScreen } from '../../../../src/screens/community/GroupDetailScreen';

export default function MyGroupDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <GroupDetailScreen id={id} />;

Suggestion: Clarify in the plan that the new parity-gaps tests will use their own expo-router mock (e.g. a new tests/parity-gaps/mocks.ts) with a Redirect spy that captures href and a useLocalSearchParams that returns the desired params. Do not claim community/mocks.ts is imported for the expo-router stub; the new tests can still import community/helpers.tsx (for the Supabase double / wrapper) and helpers/no-network.ts without conflict, since those don't re-mock expo-router.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
