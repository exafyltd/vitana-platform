# Responses — session 2, round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Correct: tests/community/mocks.ts:26 stubs Redirect as () => null and useLocalSearchParams as () => ({}), and importing it would defeat a per-test stub. plan.md Decision 4 now says the new tests use their own tests/parity-gaps/mocks.ts (Redirect spy recording href, mutable useLocalSearchParams holder, router/usePathname/useGlobalSearchParams, plus copies of the async-storage, secure-store and safe-area stubs) and import only tests/community/helpers.tsx (Supabase double and wrapper, which does not mock expo-router) and tests/helpers/no-network.ts, unedited. The lane tests list and tasks.md (new T0, T1, T2) are updated; mocks.ts is a new file under the lane path apps/mobile/tests/parity-gaps/**."}
]
```
