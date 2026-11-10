# Sparring round 2 — in_progress

Session: `17092071-449c-4b3b-a7d5-d3f3166a9b12` · plan hash `91d285f68451a955d4d16747c041d8eca13102dcb370e3b032d671b2989e0ced`

## Summary

Round 2: The planner accepted all three R1 findings. R1-F2 (script location clarified) and R1-F3 (red-on-base via throwaway worktree + scripted gate) are addressed in the revised plan text. R1-F1 (unverifiable vitana-v1 premises) is NOT effectively addressed: the remedy (evidence.md) exists only on the PR branch, unreachable at the pinned base commit; and the working spar_refs mechanism in plan-spar.mjs was not used to pin vitana-v1 for this sparring session. Zero vitana-v1 premises are verifiable. One finding re-raised.

## Findings

### R2-F1 [blocker]

R1-F1 remedy is ineffective: evidence.md is unreachable at the pinned commit and the existing spar_refs mechanism was not used to pin vitana-v1. The planner's accepted remedy was to add .kiro/specs/native-parity-test-gaps/evidence.md with machine-generated excerpts from vitana-v1. However: (a) the native-parity-test-gaps spec folder does not exist at the pinned base commit (6dc6e1b) — it is a PR-branch-only file the sparring partner cannot read (read_file returns 404); (b) the spar_refs mechanism already exists in plan-spar.mjs (parseSparRefs at lines 60-73, handoff.md read and extra_refs forwarding at lines 286-293, spread into client.create at line 319) and could have pinned vitana-v1 at the declared SHA (e31bf46) for this session — a spar_refs declaration in handoff.md is all that is needed. It was not used: read_file/list_dir on vitana-v1 returns 'no pinned ref'. Every premise about vitana-v1 code (intents/mine.tsx content, my-groups/[id].tsx content, resolve.ts NATIVE_ROUTES/NATIVE_PATTERNS, ledger.json rows, jest.config.js roots, test helper availability, absence of existing tests, parity-ledger.mjs --check output) remains unverified. The mandate requires at least 3 premises verified with read_file; zero are verifiable for vitana-v1.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:60` — export function parseSparRefs(fm) { const raw = fm?.spar_refs; if (raw === undefined || raw === null) return []; ...
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const handoffForRefs = path.join(spec, 'handoff.md'); const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : []; let extraRefs; for (const [r, ref] of declared) { ... (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl }); }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:319` — ...(extraRefs ? { extra_refs: extraRefs } : {}),

Suggestion: Declare spar_refs in the plan's handoff.md front matter: `spar_refs: [exafyltd/vitana-v1: e31bf4627ff3c705c20f8e6b718ce4dd03353b7f]`. This uses the existing mechanism (plan-spar.mjs lines 60-73, 286-293, 319) and makes every vitana-v1 premise verifiable by the sparring partner's read_file tool. evidence.md is a useful secondary artifact but cannot substitute for tool-verifiable access.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
