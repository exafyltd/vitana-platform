# Sparring round 1 — in_progress

Session: `869ca9e4-b9c6-4d28-8a9e-3580a9ec58ad` · plan hash `a43813c289ba2f6143440e0d88ab94da310dabd6a4ea09455f732cf72b7c27a1`

## Summary

The plan is detailed and mostly transparent about its trade-offs, but it has two material defects: (1) the numbering scheme contradicts its own "stable numbers" claim — NEVER 1–40 and all IF–THEN rules are renamed to N/T labels, silently invalidating the (out-of-scope, unfixed) external references that premise 4 documents, and (2) Decision 2 bakes a factually false `executor: claude` into lane front matter (whose documented meaning is "who builds it") purely to pass the protected-gate validator while Kiro actually builds — a governance-artifact integrity problem even though the merge is ultimately blocked pending owner/Claude review. Several premises (section layout, NEVER numbering, v1 duplication, queue.mjs gate behavior) verified as accurate.

## Findings

### R1-F1 [major]

The Numbering scheme (J) contradicts the plan's own 'stable numbers, no reuse' premise. NEVER 1–40 become N1–N40 and every IF–THEN rule becomes T1..Tn 'numbered once in reading order', so surviving NEVER/IF–THEN rules do NOT keep their current numbers. Decision 5 ('Numbering keeps every surviving number stable') is therefore only true for ALWAYS and the standing-rule blocks 41–55. Any external reference to a 'NEVER n' or 'IF–THEN n' number — which premise 4 counts in the hundreds across `.claude/rules/*.md`, `docs/**`, `.kiro/**`, and code comments — dangles, and the plan fixes only the ones inside lane paths, merely listing the rest in the PR body. Files like `.claude/rules/*.md` (path-scoped but still loaded, including the always-loaded steering/collaboration files) and code comments that cite 'NEVER 27', 'NEVER 35', 'IF–THEN 26', etc. will point at renamed or deleted labels after this change.

- `exafyltd/vitana-platform:CLAUDE.md:244` — ## ❌ NEVER RULES ... 1. **Never invent new projects, environments, or services.** ... 40. **Never bypass validation.**
- `exafyltd/vitana-platform:CLAUDE.md:158` — see rules 51–55 (Plan Sparring Gate).
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:84` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', ... 'CLAUDE.md', 'docs/programs/areas.yaml'];

Suggestion: Either (a) keep plain numbers for the NEVER 1–40 (and give the colliding IF–THEN ranges distinct section-prefixed labels only where they actually collide today), or (b) commit to doing the full cross-reference sweep in-repo (`.claude/**`, `.kiro/**`, `docs/**`, `scripts/**`) in these same lanes so no dangling 'NEVER n'/'IF–THEN n' reference survives, rather than deferring them to a PR-body list. A stale reference to a renamed safety rule ('NEVER 35' silent fallback, 'NEVER 7/8' tenant isolation) in a loaded rules file is a real safety hazard.

### R1-F2 [major]

Decision 2 records `executor: claude` in the lane front matter while Kiro actually builds, purely to bypass validateLane/scopeCheck refusal of an `executor: kiro` lane touching the protected gate file `CLAUDE.md`. The `executor` field's documented meaning is 'who builds it (VTID-05213)', so setting it to `claude` is a false governance artifact — the same self-declaration pattern the protected-gate list exists to prevent — even though the plan is transparent about it and cites the VTID-05278 bootstrap. Because scopeCheck (`else if (fm.executor === 'claude') continue;`) and validateLane's kiro-only protected-glob check both key off this field, the false value is what unlocks the gate, not an actual Claude-built lane.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:231` — if (fm.executor === 'kiro') { for (const g of paths) { if (globTouchesProtected(g)) e.push(`paths "${g}" reaches a protected gate file ... such a lane needs executor: claude`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:579` — else if (fm.executor === 'claude') continue;
// VTID-05276 ... a protected gate file never passes for a non-claude lane
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:55` — executor: kiro | claude      # who builds it (VTID-05213)
- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:4` — "globs": [ "CLAUDE.md",

Suggestion: Do not silently reuse a false `executor` value as if it were a routine bootstrap. Record the owner instruction as an explicit, named exception in the lane log/PR (mirroring §7b's 'owner instruction naming a PR or set of PRs'), and have the owner (or legacy Claude, per §3a) sign off on that specific mechanism before the lanes are marked ready — so the false field value is a documented owner exception rather than an agent self-unlocking a protected gate by declaring a field.

### R1-F3 [minor]

K downgrades the 'Mandatory Codebase Intelligence Workflow' to a 'recommended' tool section and drops its mandatory gates: index-freshness verification, the pre-execution code map, the 'no broad grep / read before executing' ban, and the mandatory re-index of both indexes after every change. None of these appear in the MUST-KEEP list, so this is a discretionary removal of an explicit, always-loaded process rule (not just a generic 'be careful' line). It is defensible under the plan's goal but is a real weakening of an anti-assumption/hallucination process, and the plan does not flag it as a weakened rule in its MUST-KEEP audit.

- `exafyltd/vitana-platform:CLAUDE.md:933` — ## Mandatory Codebase Intelligence Workflow

Before planning, modifying, debugging, reviewing, or generating code, always query both RepoWise and Graphify. Do not begin implementation from assumptions or broad grep searches.
- `exafyltd/vitana-platform:CLAUDE.md:997` — 3. Update both indexes: - `repowise update` - `graphify --update` ... A task is not complete until the implementation is verified and both indexes are current.

Suggestion: Call this out explicitly in the MUST-KEEP/removed audit as an intentional process-rule downgrade (mandatory → recommended), so the independent reviewer and owner can confirm it is a deliberate decision rather than an accidental loss of a 'mandatory' instruction.

### R1-F4 [minor]

Internal inconsistency: the rewritten Collaboration paragraph (M) states Kiro reviews through the reviewer agent `vitana-lane-reviewer`, but a lane whose front matter declares `executor: claude` cannot name that reviewer agent — validateLane errors with 'reviewer_seat ... is a reviewer agent; it reviews only lanes with executor: kiro'. So the lanes this plan actually produces (executor: claude) follow a different review path (legacy Claude/owner, Decision 3) than the paragraph the plan is simultaneously writing. The plan should state which review mechanism these gate-file lanes actually use to avoid planting a rule text that contradicts their own front matter.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:222` — if (fm.executor !== 'kiro') e.push(`reviewer_seat "${fm.reviewer_seat}" is a reviewer agent; it reviews only lanes with executor: kiro`);
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:240` — the review entry (§3) is `Collab-Verdict: accept` from `agent:vitana-lane-reviewer (claude-sonnet-5.5)` on the PR's current head;

Suggestion: Clarify in the plan (and in the M paragraph) that `executor: claude` protected-gate lanes are reviewed by legacy Claude/owner (§3a), distinct from the reviewer-agent path, so the rewritten collaboration text and the lane front matter do not contradict each other.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
