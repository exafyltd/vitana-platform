# VTID-05278 — acceptance (kiro-autonomy-fallback / steering-rules)
Docs only; deploys nothing (no staging suite, no Gate 2 for this lane: done when merged with green checks).
Reviewed against `.kiro/specs/kiro-autonomy-fallback/tasks.md` lane `steering-rules` by
agent:vitana-lane-reviewer (claude-sonnet-5.5).

| Acceptance item (tasks.md) | Where |
|---|---|
| `collaboration.md` sha256 equal in both repos | `commands.log`; both PR bodies |
| `CLAUDE_AVAILABLE` (only `false`) + 4 h rule | collaboration.md §7 "Claude unavailable mode" |
| exceptions seat `exafyltd` | §3a, §7 |
| review trailers `Collab-Review` (lane key), `Collab-Verdict`, `Collab-Reviewer`, `Collab-Reviewed-Head` | §3 |
| protected gate file list verbatim (plan §4.3) | §3a |
| heartbeat `collab-driver/<slug>`, ≤ 15 min, alive < 45 min | §8 |
| caps 2 (PLAN-SPAR) / 6 (lanes per plan) | §8a item 2 |
| `timings.json` path + fields (plan §4.6) | §8b |
| §7a prohibitions kept; only §7b merges + re-runs of failed PLAN-SPAR / PR-GATE / STAGING-VERIFY (attempt 1) | §7a |
| no stale "implementer / Claude merges / next_actor: claude / ask the owner before" in steering | `commands.log` grep, 0 hits per repo |
| `vitana-pipeline.md` no front matter, no `#[[file:.claude/rules/…]]` link | `commands.log` |
| `CLAUDE.md`: only the roles paragraph changed | PR diff |
