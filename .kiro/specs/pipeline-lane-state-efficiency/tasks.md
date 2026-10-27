# Tasks — pipeline-lane-state-efficiency
Authoritative plan: `plan.md` (between the plan markers). VTID from CI PLAN-SPAR after policy approval; never by hand.
Branch `kiro/pipeline-lane-state-efficiency/chain-transitions` (exceptions seat while Claude is unavailable) or
`claude/…`; PR title `VTID-xxxxx (pipeline-lane-state-efficiency/chain-transitions): …`; `Collab-Session` +
`Collab-Lane` trailers; identity `kiro-agent[bot]`; no `Co-Authored-By: Claude`. Evidence in `docs/validation/<VTID>/`
(`commands.log`, `red-on-base.txt`, `acceptance.md`, `timings.json`).

<!-- lane: chain-transitions -->
## Lane `chain-transitions` (vitana-platform; executor claude; protected gate file `queue.mjs`)
- [ ] C1 Tests of plan §3.5 in `scripts/collab/queue.test.mjs`, written first; record them red on `origin/main`.
- [ ] C2 `transitionChain` in `scripts/collab/queue.mjs` per plan §3.1 (exported), and its use in `validateRange`
      per §3.2-§3.3.
- [ ] C3 `node --test scripts/collab/*.test.mjs`; `node scripts/collab/queue.mjs validate --repo . --base origin/main
      --head HEAD`; preflight; record pass/fail counts in `commands.log`.
- [ ] C4 Replay check: run `validate` over the range of an existing multi-PR closing sequence squashed into one
      synthetic branch (owner-autonomy `v1-rules` #4397+#4399+#4400+#4401 log entries) and record that it passes; and
      over the same range with the accept entry removed, recorded failing.

**Acceptance**
- Change types: Tooling/CI (governance path, protected gate file).
- Only `queue.mjs`, `queue.test.mjs` and this lane's evidence change; the edge tables, `checkTransition`'s
  single-edge result and every per-commit authorization rule are unchanged (diff shows no edit to those lines other
  than the call site).
- Every valid and invalid case of plan §3.5 is a test, red on base, green on head; a single legal edge still passes
  with no new evidence demanded.
- A chain fails closed: unknown header → no edge → the file fails as today.
- Converging round 2 note (R2-F1, minor): the reviewer-append authorization that §3.3 relies on is
  `queue.mjs:590` (`k.review === key && !frontMatterChanged(...)`), not `:597`.
- Merge only with a legacy Claude review on the current head or an owner instruction naming this plan (§3a).
