# VTID-05351 acceptance (pipeline-lane-state-efficiency/chain-transitions)

| Acceptance (tasks.md) | Evidence |
|---|---|
| Only `queue.mjs`, `queue.test.mjs` and this lane's evidence change; edge tables, `checkTransition` and every per-commit authorization rule unchanged | `git diff origin/main --stat`; the diff in `queue.mjs` adds `transitionChain` + helpers and replaces only the two lines of the transition loop in `validateRange` |
| Every valid and invalid case of plan §3.5 is a test, red on base, green on head | TEST: queue.test.mjs "transitionChain: valid lane chains…", "…valid plan chain…", "…invalid chains each fail…", "validate: a closing-record PR may carry…", "validate: a chain whose accept entry has no Collab-Review commit fails…"; `red-on-base.txt` (5 fail), `commands.log` (58/58) |
| A single legal edge still passes with no new evidence | TEST: "validate: a chain whose accept…" second half (executing → in-review without a PR link passes); the existing transition tests pass unchanged |
| A chain fails closed (unknown header → no edge) | `entryEdge` returns null for unknown headers; < 2 logged edges → the single-edge result stands (`validateRange`) |
| Authorization unchanged | TEST: second session in the same chain → "one session per lane"; forged accept without `Collab-Review` commit refused (also in the real-data replay, `replay-owner-autonomy.txt`) |
| Each safeguard is load-bearing | `commands.log` mutation checks: commit backing, merge sha, append-only, parked_from, time order, PR reference |
| Merge routing | Protected gate file `queue.mjs`: merge only with a legacy Claude review on the current head or an owner instruction naming `pipeline-lane-state-efficiency` |

Change types: Tooling/CI (governance path, protected gate file). Deploys nothing.
