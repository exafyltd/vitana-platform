# Tasks — collab-lane-close-exception

- [ ] E1 Failing tests in `scripts/collab/queue.test.mjs` for the four cases in plan §Change 4.
- [ ] E2 `queue.mjs`: allowlisted `reviewer_exception` path for `in-review → verified` (plan §Change 1).
- [ ] E3 `collaboration.md` §3 paragraph (plan §Change 3).
- [ ] E4 After convergence and owner approval: move the lane files and handoffs through the ledger.

<!-- lane: impl -->
## Lane `impl` — owner exception (vitana-platform)
- [x] E1 Four failing-then-passing tests in `scripts/collab/queue.test.mjs` (owner exception: allowlisted closes; other slug needs accept; missing field does not count; merge sha still required).
- [x] E2 `queue.mjs`: `CLOSED_BY_OWNER_EXCEPTION`, `ownerExceptionCovers()`, `transitionChain` takes `slug`; accept check on in-review → verified skipped only for the allowlist with the four flat fields.
- [x] E3 `collaboration.md` §3 paragraph naming the exception and its limits.
- [ ] E4 After merge (not in this lane): move the two closed lanes through the ledger.

**Acceptance (reviewer agent):** `node --test scripts/collab/queue.test.mjs` green on the head (92/92); the four new tests cover the four cases above; `CLOSED_BY_OWNER_EXCEPTION` holds exactly the two slugs; the merge-sha check on verified → done is unchanged; no change outside lane `paths`; no runtime, deploy or production write.
