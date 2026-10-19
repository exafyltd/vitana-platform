# Sparring round 2 — planner responses

Session: `b9c548f7-6f0e-4151-81f1-48a0b8a42d85` · plan hash `9750d3fe5d0667fc7f22b8c0d9e807ab42504e847664e8a1f5ec84fecfef3d88`

Both findings are accurate against the merged code and are accepted. R2-F1 is a real internal
contradiction in the plan prose, not a change of intent: the R1-F3 resolution and the Scope section
already state that the merge, `resolveRef` call and fail-loud contract live **inside** `step()`'s
`if (!cur || retryInfra || replan)` branch, but the R1-F1 resolution body described the same merge as
happening in `main()` before `step()` is called, which — read literally — would move the `handoff.md`
read and overlay out of the create branch and fire them on every invocation (including a `round` on an
existing in-progress session), re-introducing exactly the R1-F3 bug. The R1-F1 body is rewritten to
describe the *logical precedence rule* only (`spar_refs` overlays the CLI-arg value for the
`exafyltd/vitana-v1` key) and to state unambiguously that the physical location of the read, parse,
merge, `resolveRef` call and fail-loud throw is inside `step()`'s create branch; `main()` continues to
pass the CLI-arg map (or `null`) into `step()` as `extraRefs`, exactly as today
(`plan-spar.mjs:317-319` → `step()` spread at `:192-196`).

R2-F2 is accepted: the Scope section now states that a missing `handoff.md` at create time yields
`spar_refs = {}` (no companion refs declared) via an `existsSync` guard, mirroring the guards already
used in the converged/escalated write-back paths (`plan-spar.mjs:258`, `:274`), so a brand-new plan PR
without a `handoff.md` does not throw a spurious `ENOENT` that would masquerade as a fail-loud
`spar_refs` validation error.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Confirmed against the code: main() builds extraRefs from the --extra-ref-vitana-v1 CLI arg and passes it into step() (plan-spar.mjs:317-319); step() consumes extraRefs only inside the if (!cur || retryInfra || replan) create branch, spread into the single client.create (:192-196), while the round/waiting_for_planner/nothing_to_do paths never touch it. The R1-F1 resolution body's sentence 'main() first builds the CLI-arg map... then overlays the parsed spar_refs on top of it' described the merge as living in main() before step(), contradicting the Scope and R1-F3 sections which place it inside step()'s create branch; read literally it would move the handoff.md read/overlay into main() and fire it on every invocation including a round, re-introducing the R1-F3 bug. Fixed: the R1-F1 body now states the spar_refs-overlays-CLI-arg rule as a logical precedence rule only, and the plan states explicitly that the handoff.md read, parseSparRefs call, { ...cliRefs, ...sparRefs } merge, resolveRef call and fail-loud throw all live inside step()'s if (!cur || retryInfra || replan) branch — never in main(), which continues to pass the CLI-arg map (or null) as extraRefs unchanged."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Confirmed: the existing converged/escalated write-back paths guard the handoff.md read with existsSync (plan-spar.mjs:258, :274), but the plan did not state what step() does when handoff.md is absent at create time (a brand-new plan PR may not have one), so an unconditional readFileSync would throw ENOENT and fail the create step with a file-not-found error masquerading as a fail-loud spar_refs validation error. Fixed: the Scope section now states that if handoff.md does not exist when step() enters the create branch, parseSparRefs returns {} (no companion refs declared) and no error is thrown, with the existsSync guard matching the pattern used in the converged/escalated write-back paths."
  }
]
```
