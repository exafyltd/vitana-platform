# Sparring round 1 — in_progress

Session: `95453804-2153-4c96-b410-aec841af9f7c` · plan hash `0dd847a8516af71cea7192f32629af1972a9c8dc708c9b6a3f31abb737ae8aee`

## Summary

The plan's premises about the codebase are accurate in almost every respect: the seat map structure, loadSeats parsing, governance paths, protected-gate-files, test file existence, and GitLab accounts all check out. Two concrete defects found: (1) the seat count in §6 and §7 is wrong (says 7, should be 9), and (2) the plan's §4 adds seats for Kiro slots 7–8 while the owner directive it quotes says "Preserve Kiro 7–11 as pending slots," creating ambiguity about the intended scope.

## Findings

### R1-F1 [major]

The plan says 'seven seats' in §6 ('a check that loadSeats returns the seven seats') and §7 ('Seven seats, each with kiro: and no account:'), but §4 explicitly adds five new seats (vitanaland, office, support, admin, tasks) to the four existing ones (hotmail, exafy, exafyltd, jtadic), giving 9 total — not 7. A validation assertion of 7 would fail at 9; alternatively a builder might add only 3 seats (to hit 7) and omit admin/tasks, contradicting §4.

- `exafyltd/vitana-platform:docs/programs/areas.yaml:14` — seats:
  jtadic:   { surface: kiro-web, automation: .kiro/automations/jtadic.md }
  exafyltd: { surface: kiro-web, automation: .kiro/automations/exafyltd.md }
  hotmail:  { surface: kiro-ide }
  exafy:    { surface: kiro-web, automation: .kiro/automations/exafy.md }

Suggestion: Correct §6 and §7 to say 'nine seats' (4 existing + 5 new), or if only three new seats are intended, correct §4 to remove admin and tasks.

### R1-F2 [major]

The plan quotes the owner: 'Preserve Kiro 7–11 as pending slots.' But §4 creates actual seat entries for Kiro 7 (admin) and Kiro 8 (tasks) with surface: pending. Meanwhile §7 says 'slots 7–11 listed as reserved'. The plan treats slots 7–8 simultaneously as real seats (in §4) and as reserved pending slots (in §7). This is internally contradictory and creates ambiguity for the builder. If the owner intends 7–11 to be comment-only (like 9–11), then adding admin/tasks as seats is wrong; if the owner wants them as seats, then '7–11 reserved' in §7 is wrong.

- `exafyltd/vitana-platform:docs/programs/areas.yaml:14` — seats:
  jtadic:   { surface: kiro-web ... }
  ...
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1186` — export function loadSeats(repo, ref) { ... const m = inSeats && /^ {2}([a-z]{1,12}):/.exec(line); if (m) seats.add(m[1]); ...

Suggestion: Resolve the contradiction: either (a) slots 7–8 are real seats in areas.yaml (surface: pending), and §7 should say 'slots 9–11 reserved', not 7–11; or (b) slots 7–8 belong only in the comment block (like 9–11) and §4 should list only three new seats (vitanaland, office, support). Clarify with the owner directive.

### R1-F3 [minor]

The plan references 'automations.test.mjs:29' as the line that parses only the inline { } form. The actual regex is at line 30. Off-by-one in line citations can mislead the builder when checking compatibility.

- `exafyltd/vitana-platform:scripts/collab/automations.test.mjs:29` —     }
    const m = inSeats && /^ {2}([a-z]{1,12}):\s*\{(.*)\}/.exec(line);
    if (m) {

Suggestion: Update the citation to line 30.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
