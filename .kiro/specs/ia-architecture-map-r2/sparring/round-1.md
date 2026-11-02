# Sparring round 1 — in_progress

Session: `764ea791-ba4c-420a-9e2e-d01107642b51` · plan hash `39c98ae19965d49a8fddff487a0a9642aec7300b717e9e86b9dccb70ee3c448c`

## Summary

This is a documentation-only plan with a narrow scope: publish an integrated architecture map under `docs/architecture/integrated-architecture/`, add a CONTEXT-MAP row, and register as a workstream of the multi-tenant programme. The premises about the CI guard (`context.mjs check`, `UNIT.yml`), the domain atlas, `require-tenant-admin.ts`, and the loop catalog all hold. However, the plan's description of what `program.md` currently contains is factually wrong at the pin — it already lists 6 specs, not 3, and `mt-track-s-authz` is already present. This matters because the plan's merge-conflict strategy in §5 is based on the stale premise. One minor concern about an unverifiable vitana-v1 reference.

## Findings

### R1-F1 [major]

The plan states (§2) that program.md 'lists the specs multi-tenant, mt-jobs and mt-launch' and that 'Plan mt-track-s-authz (PR #4579) adds itself there.' At the pin, program.md already lists 6 specs: multi-tenant, mt-jobs, mt-launch, mt-track-s-authz, mt-track-s-r2, and mt-guardrails-r2 (lines 7-13). mt-track-s-authz is already present. The plan's merge-conflict analysis in §5 ('which PR #4579 also edits; the second to merge takes both list entries') is based on this stale premise and may lead to an incorrect merge or duplicated entry.

- `exafyltd/vitana-platform:docs/programs/multi-tenant/program.md:7` — specs:
  - vitana-platform:multi-tenant
  - vitana-platform:mt-jobs
  - vitana-platform:mt-launch
  - vitana-platform:mt-track-s-authz
  - vitana-platform:mt-track-s-r2
  - vitana-platform:mt-guardrails-r2

Suggestion: Update §2 and §5 to reflect the actual current state of program.md at the pin (6 specs, mt-track-s-authz already present). Describe exactly what the plan PR will add (presumably a WS-IA spec entry) and re-assess the merge-conflict scenario against the correct baseline.

### R1-F2 [minor]

The plan (§2) references vitana-v1 `src/design/screen-manifest.json` as existing module metadata that later plans extend. A GitHub search on the vitana-v1 repo for 'screen-manifest' returns no hits. Without a pinned ref for vitana-v1, this cannot be confirmed with read_file. The CONTEXT-MAP.md row at line 11 does reference the same path, so it may be valid — but the plan's §3.1 reference-check script should verify this path before publishing it in the architecture map.

- `exafyltd/vitana-platform:docs/CONTEXT-MAP.md:11` — | Which page renders a vitana-v1 path, is it registered? | `node scripts/dev/context.mjs screen /inbox` | `vitana-v1/src/App.tsx`, `vitana-v1/src/navigation/registry/screens.json`, `vitana-v1/src/design/screen-manifest.json`, `vitana-v1/apps/mobile/parity/ledger.json` | `vitana-v1/src/navigation/registry/registry.routes.test.ts`, NATIVE-CI |

Suggestion: Verify the vitana-v1 screen-manifest.json path at the current v1 HEAD before publishing it in the architecture map. If it has been renamed or relocated, use the correct path.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
