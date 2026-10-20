# Design — claude-md-cleanup

## What exists (pinned: vitana-platform `3619021bc`, vitana-v1 `05cca2209`)
Platform `CLAUDE.md` (1021 lines):
| Range | Section | Plan item |
|---|---|---|
| `:7-41` | GCP banner | D |
| `:46-112` | Autonomy contract | L (keep, condense wording only) |
| `:115-127` | Collaboration | M |
| `:140-169` | ALWAYS source of truth (2b at `:144-161`) | A, I |
| `:171-191` | ALWAYS 10a–10c Bedrock | L |
| `:193-214` | ALWAYS infra (20–22 at `:212-214`) | A, B |
| `:216-227` | ALWAYS database & memory | L (21–30 keep) |
| `:229-240` | ALWAYS frontend (31–34 sidebar) | H |
| `:248-305` | NEVER generic 1–40 | A, H, I, G |
| `:307-514` | standing-rule blocks 41–55, 42a–42h | L (condense wording only) |
| `:520-548` | IF–THEN VTID, governance, infra | I |
| `:550-556` | IF–THEN deployment verification | B |
| `:558-641` | visual verification, test user, auth snippet | C |
| `:643-706` | CI/CD staging-first + rule 26 | E |
| `:708-722` | IF–THEN memory, frontend | A, H, I |
| `:724-766` | IF–THEN AI 26–31 | D, F |
| `:770-795` | Part 2 pointers | L, G |
| `:797-902` | §4 VTID system | I, L, G |
| `:904-922` | §5 governance | L |
| `:925-931` | CHANGE LOG pointer | G |
| `:933-1021` | codebase intelligence + graphify | K |

v1 `CLAUDE.md` (574 lines): collaboration `:96-106` (M); testing + "Why no host is exempt" `:254-311`; codebase
intelligence + graphify `:486-574` (K). Steering files in both repos: `vitana-kiro-notes.md` (23 lines),
`vitana-load-project-rules.md` (26 lines), byte-identical across repos today.

## Decisions
- **Stable numbers (R1-F1).** Every surviving rule keeps its plain digits in ALWAYS, NEVER, IF–THEN and the
  standing-rule blocks; deleted numbers are retired and listed in a retired-number index; merged rules keep the
  lowest number. The edits remove every collision but one; IF–THEN AI 27–31 become `AI-27`–`AI-31` (same digits,
  aliased "cited elsewhere as IF–THEN 27–31") so the test-account rules keep plain 31/31b/32. The ~530 external
  references (`.claude/rules/**`, `docs/**`, `.kiro/specs/**`, `scripts/**`, code comments) all resolve; the sweep
  evidence (`outputs/xref-sweep.md`) shows how.
- **Codebase intelligence downgrade (R1-F3).** Mandatory → recommended is recorded as an intentional,
  owner-instructed weakening in the diff review, not hidden among condensations.
- **Condense, never reword meaning.** For every MUST KEEP item the new text keeps the trigger, the action and the
  named file/flag/endpoint; only narrative, duplicated explanation and incident numbers go.
- **One "why" clause per incident**, VTID kept (for example: "a test account once sent 445 identical DMs
  (VTID-03990)").
- **Steering files stay byte-identical** across the two repos after the change.
- **Lane executor — named owner exception (R1-F2).** `executor: claude` is the §7 route for a protected-gate lane
  (Claude Code, else the exceptions seat); Kiro builds these lanes on the owner's explicit instruction of 2026-10-20,
  recorded in plan Decision 2, each lane's claim log entry and the first section of each lane PR body, where the owner confirms it
  with the content. No gate script is touched; not a precedent.
- **No merge by Kiro; review path (R1-F4).** Protected gate file → owner / legacy Claude review on the current head
  is the accepting review (§3a); the reviewer agent's review is advisory, non-author input. No `reviewer_seat`.

## Flow per lane
```
claim lane → branch kiro/claude-md-cleanup/<lane> from latest origin/main
→ record line counts + MUST-KEEP token grep (before)
→ edit (plan items) → token grep (after) + duplicate-label grep + line counts
→ evidence docs/validation/<VTID>/{acceptance.md,commands.log,outputs/}
→ queue.mjs validate → PR "VTID-xxxxx (claude-md-cleanup/<lane>): …" → reviewer agent → ready, not merged
```
