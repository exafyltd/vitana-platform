# VTID-04013 — Agent executor: tsc reports TS2742 on the symlinked node_modules clone (found by Test Run #4b)

Context: Test Run #4b (VTID-04012, execution `4f7d5ea4`, staging, ECS task `1a2b8b57` on `vitana-autopilot-executor:10`, which carries the VTID-04009 heap fix). `run_check tsc` now completes (53 s, no allocation failure) but exits 2:

```
src/services/automation-handlers/connect-people-repository.ts(30,23): error TS2742: The inferred type of 'fetchPrimaryTenantUsers' cannot be named without a reference to '../../../../../..
```

The clone's `services/gateway/node_modules` is a symlink to the image's `/app/node_modules` (`linkNodeModules`, VTID-04006). TypeScript resolves the symlink to its realpath, which lies outside the project root, so an export whose inferred type comes from a library (`@supabase/supabase-js` here) cannot be named relative to the project — TS2742. The identical commit typechecks clean on a real install (this session: `tsc --noEmit` exit 0, and again exit 0 with `--preserveSymlinks`). This is an environment artifact of the executor, not a defect in the code, and the post-hoc runner would report it on every fix round.

AC-1 — `runTsc` invokes tsc with `--noEmit -p tsconfig.json --preserveSymlinks` (exported `TSC_ARGS`), so module paths are resolved through the symlink rather than its realpath; the heap `NODE_OPTIONS` from VTID-04009 is unchanged.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

AC-2 — On a real (non-symlinked) install the flag is a no-op: the gateway typechecks clean with it.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

Not verified here: a real agent execution on the rebuilt image — the next Test Run on staging is the first live exercise.
