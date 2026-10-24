# Sparring round 2 — in_progress

Session: `d1ebba9d-5a1b-4acb-ab2f-de219d1c4ec7` · plan hash `53dce247f53ec244cdafaa7c0024df739f4e12af65517eb7cf5857e25fcec27a`

## Summary

Round 2 cannot make progress on the merits: the code-access conditions that would let me verify the plan's load-bearing premises are still absent, and the plan's own files are missing from the pinned commit. (1) `exafyltd/vitana-v1` still returns "no pinned ref" for read_file — the `spar_refs: - exafyltd/vitana-v1: main` fix the planner claims to have added to handoff.md did not reach this session, so no vitana-v1 file (ledger.json, ESLint config, vcal/time.ts, liveRoom.ts, the 22 web sources) can be read. (2) The `native-wave2-events-calendar` spec directory does not exist at the pinned commit `84fc0ca6a0d116f4e41dfd77c5125cb329b95f15` — `.kiro/specs/` lists no such directory, and read_file on its handoff.md/plan.md returns 404. The sibling `native-wave2-home-feed-news` plan exists at this same commit in state `approved`, proving the spec tree is present and the events-calendar plan is genuinely absent. Consequently R1-F1 (blocker) is re-raised as unresolved and worsened. R1-F2 and R1-F3 remain unverifiable by construction until vitana-v1 is pinned. R1-F4's claimed fix is disputed — the handoff.md it references is not in the repo at the pinned commit, and vitana-v1 was not forwarded this round. No new merits-level findings can be raised until these two infrastructure defects are fixed and a genuine round-3 session is created against a commit that (a) contains the spec files and (b) forwards a deterministic vitana-v1 companion ref (a 40-hex SHA, not `main`).

## Findings

### R1-F1 [blocker]

Still unresolved and now worse: the events-calendar plan's files are entirely absent from exafyltd/vitana-platform at the pinned commit, and exafyltd/vitana-v1 is still not forwarded, so no load-bearing premise of the plan can be verified against code. list_dir on .kiro/specs at the pinned commit shows the sibling native-wave2-home-feed-news directory but NO native-wave2-events-calendar directory, so the events-calendar handoff.md/plan.md the planner claims to have edited are not in the repo. read_file on any vitana-v1 path returns 'no pinned ref for exafyltd/vitana-v1 in this session', and this is explained by plan-spar.mjs lines 286-292: it only builds extra_refs by reading the plan's handoff.md, which does not exist here, so extraRefs stays undefined and vitana-v1 is never forwarded. The plan's core claims (22-row ledger partition, class-A/class-B closures, ERROR-level i18n/no-raw-locale-call, the 22 web destinations, the 12+4+6 lane split) are therefore all unverifiable, and the plan cannot converge.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const handoffForRefs = path.join(spec, 'handoff.md'); const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : []; let extraRefs; for (const [r, ref] of declared) { if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(...); if (r === repo) throw new Usage(...); (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl }); }
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:131` — The first sparring session escalated on infrastructure... the vitana-v1 ref fix is merged to main (PR #4201, fa73aabd0), so PLAN-SPAR forwards extra_refs: { 'exafyltd/vitana-v1': <sha> } and a session created from this branch ... can read exafyltd/vitana-v1 to verify this plan's apps/mobile/** and web screen premises.

Suggestion: Do not converge this session. The actual spec files must be committed to a real plan PR branch in exafyltd/vitana-platform (so list_dir(.kiro/specs) contains native-wave2-events-calendar), its handoff.md must declare `spar_refs: - exafyltd/vitana-v1: <40-hex-sha>` (a concrete resolved SHA, not `main`, for determinism), and the sparring session must be re-created so read_file can actually resolve vitana-v1. Until then any approval rests on a plan text that cannot be checked against the code it describes.

### R1-F4 [major]

The planner's accepted fix for R1-F4 is not real: it claims 'the events-calendar handoff.md front matter now declares spar_refs: - exafyltd/vitana-v1: main' and is 'verifiable at .kiro/specs/native-wave2-events-calendar/handoff.md', but that path returns 404 at the pinned commit because the directory does not exist in the repo. The plan-spar.mjs mechanism (lines 286-292) reads exactly this handoff.md to build extra_refs; with no file present, extraRefs stays undefined and vitana-v1 is not forwarded — which is why read_file on vitana-v1 reports 'no pinned ref'. The declared recovery path has therefore not been executed against this repo/commit.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : []; ... (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:11` — A plan that spans both repos declares a companion ref in handoff.md front matter under `spar_refs:` (`- exafyltd/vitana-v1: <branch|tag|40-hex-sha>`). plan-spar.mjs resolves it to a commit SHA ... No declaration ⇒ byte-identical to today.

Suggestion: Commit the actual handoff.md (with the spar_refs block declaring a concrete 40-hex vitana-v1 SHA) to the plan branch, and re-create the sparring session against the resolved commit. Follow the sibling home-feed-news pattern, which converged only after PR #4201 merged the vitana-v1 forwarding fix into main so the base already carried it.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — Rationale is sound in principle (wholesale regeneration of the two generated files + append-only keep-both manifest, with a serialized depends_on fallback), but it cannot be accepted as resolved this round because the plan.md and core-closure.mjs behavior it depends on are unreadable (vitana-v1 not pinned; events-calendar plan.md 404). Will re-verify on the merits once code access is restored.
- R1-F3: acknowledged — Accepted as needing verification next round; the planner defers verification, but no next-round verification was possible because vitana-v1 is still not pinned in this session and vcal/time.ts, liveRoom.ts and the ESLint config are unreadable. Remains open until vitana-v1 is actually forwarded.
- R1-F4: disputed — The claimed fix (spar_refs added to handoff.md) is not present: the events-calendar handoff.md returns 404 at the pinned commit and its directory does not exist in the repo, so vitana-v1 was not forwarded this round (read_file returns 'no pinned ref'). The assertion the fix is 'verifiable at .kiro/specs/native-wave2-events-calendar/handoff.md' is false at this commit.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
