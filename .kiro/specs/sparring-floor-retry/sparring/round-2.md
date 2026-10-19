# Sparring round 2 — in_progress

Session: `12379be3-6ae6-4f7a-a93a-f79d41ce419a` · plan hash `67fe5ac650cd8e000a48d438c43240cb6bc23cc7de869a75ecc67c49b15905ce`

## Summary

All three R1 findings were accepted and the revised plan addresses them coherently: the nudge exit is now named in Change 1, the `codeAccessFailed` predicate is scoped to `read_file` entries with an `isAccessStatus` guard, and the migration is explicitly ordered before the `retryInfra`/`replan` computation. One new major finding: `types.ts` is not in the change list but must be updated for the plan to compile.

## Findings

### R2-F1 [major]

`types.ts` is absent from the change list but `ToolLogEntry` must gain `status?: number` before Change 1 can compile. The `fail` helper in `github-tools.ts` (L125-128) takes `extra: Partial<ToolLogEntry>`, so passing `{ status: resp.status }` to it is a TypeScript error unless `status` is a declared member of the interface. Equally, `partner.ts`'s new `isAccessStatus(e.status)` expression, where `e: ToolLogEntry`, produces a TS2339 'Property status does not exist' error. The verification step `npx tsc --noEmit` will fail immediately on both sites.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/types.ts:78` — export interface ToolLogEntry { name: 'read_file' | 'list_dir' | 'search'; repo?: string; path?: string; ok: boolean; approximate?: boolean; }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:125` — const fail = (msg: string, extra: Partial<ToolLogEntry> = {}): ToolExecution => ({ result: msg, isError: true, log: { ...base, ...extra, ok: false }, });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:143` — const resp = await doFetch(url, { method: 'GET', headers: headers() }); if (!resp.ok) return fail(`GitHub ${resp.status} reading ${repo}/${path}@${ref}`, { path });

Suggestion: Add `status?: number` to the `ToolLogEntry` interface in `types.ts` and list `types.ts` in the Change 1 file list. The catch-block at `github-tools.ts` L197-199 (network errors) and the no-token guard at L131 both need `status: 0` in their `fail` calls; the local-refusal paths (invalid path L139, no pinned ref L141, directory/submodule L147) correctly omit it. All of these are consistent with the plan's prose description and are only blocked by the missing type declaration.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The revised plan explicitly names all three `runPartnerPass` exits — nudge (~L177), invalid-submission (~L242), turn-cap (~L253) — as targets for the `codeAccessFailed` check. The fix is correctly described.
- R1-F2: acknowledged — The predicate is now scoped exclusively to `read_file` entries and gates on `isAccessStatus(e.status)` (0/401/403/5xx), excluding 404s, invalid paths and too-large files. The legacy rule adds a created_at cutoff to prevent matching new sessions. The single-token assumption is documented. All stated gaps are addressed.
- R1-F3: acknowledged — The revised plan explicitly states the migration runs 'right after `cur` is read and **before** `retryInfra`/`replan` are computed (~L186)', and test (a) asserts a `create` call rather than just flag mutation. The ordering concern and the test gap are both resolved.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
