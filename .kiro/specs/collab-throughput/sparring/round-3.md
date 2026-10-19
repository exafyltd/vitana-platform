# Sparring round 3 — escalated

Session: `2eacb48d-7f1f-43af-9d7f-d25383d7f654` · plan hash `b387c5203bab8d159e0c7e7904565922c7f5476fa6f2761155892d83990c07ff`

## Summary

Both accepted findings from round 2 (R2-F1, R2-F2) are addressed in the revised plan. One new major gap has been found: the plan promises that `main()` writes the comment file for "any gateway 4xx on create or round," but those failures surface as thrown exceptions (not returned actions) and `main()` has no mechanism to catch them and write the comment file. Rounds 1 findings (R1-F1 route ordering, R1-F2 semaphore spec, R1-F3 comment-file layer) are all addressed in the plan text.

## Findings

### R3-F1 [major]

The plan says `main()` writes the comment file for 'any gateway 4xx on create or round,' but those failures are thrown exceptions — not returned actions — and `main()` has no path to write a comment file for them. `client.create()` throws `Error('create: HTTP ${r.status} …')` when the response is non-lost and carries no `session` field (line 115 of plan-spar.mjs). `client.round()` throws `Error('round ${n}: HTTP ${r.status} …')` for the same condition (line 125). Neither is caught inside `step()`. The current `main()` has no try/catch around the `step()` call (line 306); all thrown errors fall to the rejection handler at line 312–314, which only calls `console.error` and sets `process.exitCode = 1` — no comment file is written. Change B's new logic only returns `{ action: 'responses_invalid' }` from `step()` for the locally-validated finding-id errors; it does not cover, for example, `already_approved` (409), `plan_text_too_large` (400), or `store_error` (502) on `create`. After the fix those cases would still produce a red check with the generic 'PLAN-SPAR ran: [link]' comment — the exact silent failure the plan set out to eliminate. The plan must specify the mechanism: either `step()` catches `client.*` throws and returns them as named error actions so `main()` can write the comment file, or `main()` wraps `await step(…)` in a try/catch that writes the file for any thrown error before re-throwing.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:112` — async create(body) { const r = await call('POST', '/api/v1/plans/spar', body); if (r.json?.session) return ...; if (!lost(r)) throw new Error(`create: HTTP ${r.status} ${JSON.stringify(r.json)}`); ... async round(id, n, body) { const r = await call('POST', ...); if (r.json?.session) return r.json.session; if (r.status === 409 && r.json?.error === 'round_conflict') return waitFor(id, n); if (!lost(r)) throw new Error(`round ${n}: HTTP ${r.status} ${JSON.stringify(r.json)}`); return waitFor(id, n); },
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:296` — async function main(argv) { ... const r = await step({ ... }); say(`✅ **plan-spar** — ...`); return 0; } ... main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`plan-spar: ${e.message}`); process.exitCode = e instanceof Usage ? 2 : 1; });

Suggestion: Pick one of two approaches and state it explicitly in the plan: (a) `step()` catches exceptions from `client.create` and `client.round`, converts them to `{ action: 'gateway_error', message, status }` returns, and `main()` handles all non-zero action returns the same way it handles `responses_invalid`; or (b) `main()` wraps `const r = await step(…)` in a try/catch, writes the comment file with the error message in the catch block, then exits 1. The test suite for Change B must include a case where `client.round` throws a simulated 400 and assert that the comment file is written and exit code is 1.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and addressed. The revised plan specifies `--since=<days>.days.ago` and requires the test to assert the spawned git log argv carries it. The current queue.mjs still uses the old per-branch approach (lines 259-266), confirming the change is pending implementation.
- R2-F2: acknowledged — Accepted and addressed. The revised plan normalises every `%S` value with `ref.replace(/^refs\/remotes\//, '')` before the existing guards run, adds `--exclude=refs/remotes/origin/collab-claim/*` and `--exclude=refs/remotes/origin/HEAD` before `--remotes`, and adds a fixture collab-claim ref asserting it never appears in output rows.
