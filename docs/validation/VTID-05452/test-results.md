# VTID-05452 approvals-auth: local results

Base (origin/main ed43ba6362) before the change: `test/mt-track-s-authz-approvals-auth.test.ts`: 7 failed, 7 passed
(the 7 failures are the no-bearer / non-admin cases for the three POST routes and the branch_mismatch case).

After the change, on the lane branch:
- `npx jest test/mt-track-s-authz-approvals-auth.test.ts test/vtid-05047-cicd-routes-auth.test.ts`: 2 suites, 78 tests passed.
- `npm run test:operator`: 1 suite, 71 tests passed.
- `npm run test:roles`: 1 suite, 105 tests passed.
- `npx tsc --noEmit`: exit 0.

Not run here: staging probes (run by STAGING-VERIFY after merge; read-only).
