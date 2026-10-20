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
- **Stable numbers.** Surviving rules keep their numbers; deleted numbers are retired; merged rules keep the lowest
  number. Generic NEVER rules get the prefix `N` (same digits); IF–THEN rules become `T1`–`Tn` in reading order.
  ALWAYS (1–40, 2b, 10a–10c) and the standing-rule blocks (41–55, 42a–42h) keep plain numbers, so the ~530 external
  references (`docs/validation/**`, `docs/*.md`, `.kiro/specs/**`, code comments) stay valid.
- **Condense, never reword meaning.** For every MUST KEEP item the new text keeps the trigger, the action and the
  named file/flag/endpoint; only narrative, duplicated explanation and incident numbers go.
- **One "why" clause per incident**, VTID kept (for example: "a test account once sent 445 identical DMs
  (VTID-03990)").
- **Steering files stay byte-identical** across the two repos after the change.
- **Lane executor.** `executor: claude` in the lane files is the value `queue.mjs validateLane` (`:231-235`) requires
  for a lane that declares the protected gate file `CLAUDE.md`; Kiro builds the lanes (owner instruction 2026-10-20),
  as in `kiro-autonomy-fallback/steering-rules`. No gate script is touched.
- **No merge by Kiro.** Protected gate file → owner review on the current head.

## Flow per lane
```
claim lane → branch kiro/claude-md-cleanup/<lane> from latest origin/main
→ record line counts + MUST-KEEP token grep (before)
→ edit (plan items) → token grep (after) + duplicate-label grep + line counts
→ evidence docs/validation/<VTID>/{acceptance.md,commands.log,outputs/}
→ queue.mjs validate → PR "VTID-xxxxx (claude-md-cleanup/<lane>): …" → reviewer agent → ready, not merged
```
