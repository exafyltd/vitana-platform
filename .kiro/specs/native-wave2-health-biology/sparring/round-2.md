# Sparring round 2 — in_progress

Session: `6bae03ec-0d06-4ab2-b19e-c8dd872dae69` · plan hash `3708cef232a0602041c9c630ee6b8f67d204482ea419427acad9ef31ca1ced81`

## Summary

The core blocker from R1-F1 is NOT resolved, and the planner's chosen mitigation is provably non-functional. In this round-2 session, read_file/list_dir on exafyltd/vitana-v1 still returns "no pinned ref for exafyltd/vitana-v1 in this session," so NONE of the four code-level premises (R1-F2 vitanaIndex.ts IO-freedom, R1-F3 the 4+4+16 ledger partition, R1-F4 Plans.tsx/WellnessServices.tsx no-health-data claim) can be verified — nor can the R1-F5 signature-vendoring target. Worse, the planner's remediation ("handoff.md now declares spar_refs: - exafyltd/vitana-v1: main") is contradicted by the mechanism the plan relies on: .kiro/specs/plan-spar-vitana-v1-ref/plan.md:89-96 states cross-repo spar_refs must be a verbatim 40-hex SHA and that a non-SHA (e.g. `main`) ref is a "loud declaration error" with branch/tag resolution explicitly deferred. The revised plan still contains zero per-code verification. Additionally I found a plausible contradiction in the R1-F5 remediation: the n5a lane file reports the module already "main merged in 2026-10-14 (8fea5e652)" while the remaining work is only re-vendoring the contract from C1's merge commit, so the plan's instruction to vendor a signature from "the open green vitana-v1 #1398 branch" targets a stale state. The plan should not converge until a session with a real pinned vitana-v1 SHA is obtained and the four premises are verified on the merits.

## Findings

### R1-F1 [blocker]

exafyltd/vitana-v1 still has no pinned ref in this round-2 session, so none of the load-bearing code premises can be verified. The planner's stated mitigation — declaring `spar_refs: - exafyltd/vitana-v1: main` in handoff.md — is provably non-functional because the ref-forwarding mechanism requires a verbatim 40-hex SHA for cross-repo keys and rejects branch names (`main`) as a 'loud declaration error' with branch/tag resolution explicitly deferred.

- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:89` — SHA-only for cross-repo (R1-F2): resolveRef accepts a verbatim 40-hex SHA with no API call. Branch/tag resolution via GET /repos/{owner}/{repo}/commits/{ref} is NOT used for any repo other than the plan's own --repo ... A non-SHA companion ref is a loud declaration error. Resolving a branch/tag cross-repo is deferred until a CI-accessible contents:read secret for vitana-v1 exists.
- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:78` — A plan declares a companion ref in handoff.md front matter under a new spar_refs: block list (- exafyltd/vitana-v1: <40-hex-sha>).

Suggestion: Re-trigger this session with a real 40-hex SHA for exafyltd/vitana-v1 (not `main`), e.g. via the always-on `--extra-ref-vitana-v1 <sha>` CLI arg (VTID-05215) or a correctly-formed `spar_refs: - exafyltd/vitana-v1: <sha>` entry. Only then can R1-F2/F3/F4 and the F5 signature-vendoring be verified on the merits. Until a session with a working vitana-v1 pin exists, the plan must not converge.

### R1-F5 [major]

The revised plan's R1-F5 remediation — vendoring the n5a-health-sync module's public entry signature from 'the open green vitana-v1 #1398 branch' because the module is 'owner-blocked on C1/D10 with no near-term timeline' — is built against a stale state. The lane file reports #1398 already 'main merged in 2026-10-14 (8fea5e652)', and its only remaining work is 'Re-vendor the Health Sync contract types/schema/fixtures from C1's merge commit' (a distinct step blocked on the owner applying the d10-consents migration). The plan conflates the merged module code with the not-yet-re-vendored contract types, and instructs health-hub to vendor a signature from a branch that is no longer open. The actual available interface (if any) on vitana-v1 main is unverifiable without a vitana-v1 pin, so the stub's target shape is undefined in the plan.

- `exafyltd/vitana-platform:.kiro/specs/health-native/lanes/n5a-health-sync.md:21` — vitana-v1 #1398 (branch claude/health-data-integration-plan-dbxyld-n5a), green, main merged in 2026-10-14 (8fea5e652). Remaining work for Kiro once C1 (#4107) is merged: 1. Re-vendor the Health Sync contract types/schema/fixtures from C1's merge commit
- `exafyltd/vitana-platform:.kiro/specs/health-native/tasks.md:40` — ## n5a-health-sync
- [ ] Re-vendor the Health Sync contract from C1's merge commit (contract test byte-for-byte)
- [ ] Replace the N3 auth stub and N4 flag stub with the real modules on main; delete the stubs
- [ ] Stays switched off; all NATIVE-CI gates green
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:50` — | `n5a-health-sync` | v1 #1398 (05184) | C1 merged; then re-vendor the contract from C1's merge commit and switch the N3/N4 stubs to the real modules |

Suggestion: Reconcile the Health Sync stub-vendoring step with the actual n5a state: (a) confirm whether the public read-only entry exists on vitana-v1 main (requires a working vitana-v1 pin) or lives only in the to-be-re-vendored C1 contract; (b) re-target the signature-vendoring to the correct source (C1's merge commit after it lands, or the #1398 head if still reachable), and record exactly which commit provides the signature; (c) keep the contract test but pin the module path and export name now, since 'flip to the real export automatically when N5a lands' only works if those are known and stable.

### R2-F2 [major]

The revised plan carries forward R1-F2/F3/F4 as 'accepted, verified next round' with no code-level result recorded, while the round-2 session still lacks vitana-v1 access. Concretely: (F2) vitanaIndex.ts (pillarKeys/pillarLabel/getVitanaIndexTier) IO-freedom driving Decision 2's core-extraction is unproven, so core-closure.mjs --check may fail at m.own !== 'A'; (F3) the 4+4+16=24 ledger partition is unverified, and the sibling plan's history shows such counts required three corrections (its own plan.md documents 'the earlier 6+2+19 and 8+2+17 were both wrong'); (F4) the claim that health-plans-services 'reads no health data' and can run in parallel with health-hub is unverified against Plans.tsx (383 lines, 5 tabs) and WellnessServices.tsx (286 lines, 4 tabs), and if either reaches a class-B hook it silently breaks the parallel-build claim. None of these can be independently confirmed, and the plan still asserts them as load-bearing facts.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:40` — Partition (R1-F2 / R3-F1, corrected against the ledger): home 9 parity rows ... (9+2+16; the earlier "6+2+19" and "8+2+17" were both wrong) ... parity-ledger.mjs matches by exact shapeOf() (:60), not prefix ... if the native files exist but the rows stay not_started, --check passes silently
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:53` — Only the pure IO-free compose/rank modules move into @vitana/core; the data-fetching hooks do NOT ... they runtime-import supabase/client.ts ... a class-B module ... make core-closure --check fail (core-closure.mjs:150, m.own !== 'A')

Suggestion: Before convergence, obtain a session with a working vitana-v1 pin and: read src/lib/vitanaIndex.ts in full tracing every runtime import transitively; read apps/mobile/parity/ledger.json filtering lane===health and enumerate all 24 rows by id to confirm 4/4/16 with 0 overlap and 0 orphan; read src/pages/health/Plans.tsx and WellnessServices.tsx in full tracing every hook import to confirm neither reads health data (else health-plans-services must take depends_on:[health-hub] and drop the parallel claim). Record line-level results in the Measured state block, as the sibling plan did.

## Acknowledgements of earlier responses

- R1-F1: disputed — The planner's rationale asserts 'handoff.md now declares spar_refs: - exafyltd/vitana-v1: main' which will be forwarded. This is contradicted by plan-spar-vitana-v1-ref/plan.md:89-96: cross-repo spar_refs must be a verbatim 40-hex SHA, and a branch name like `main` is a 'loud declaration error' with branch/tag resolution explicitly deferred. The round-2 session confirms vitana-v1 is still unpinned.
- R1-F2: disputed — Accepted as 'verify next round,' but this round still has no vitana-v1 pin, so the verification was not performed. Re-raised as part of R2-F2.
- R1-F3: disputed — Accepted but the promised enumeration against apps/mobile/parity/ledger.json could not be performed because vitana-v1 remains unpinned. Re-raised as part of R2-F2.
- R1-F4: disputed — Accepted but deferred to 'the next round's read'; that read was impossible (no vitana-v1 pin), so keeping health-plans-services parallel/dependency-free is still unverified. Re-raised as part of R2-F2.
- R1-F5: disputed — The remediation targets 'the open green vitana-v1 #1398 branch', but n5a-health-sync.md:21-22 reports #1398 already 'main merged in 2026-10-14'; the remaining work is re-vendoring from C1's merge commit. The signature source is stale; see R1-F5 re-raise.
- R1-F6: acknowledged — Rationale is sound: the STATUS.md row-8 edit belongs to the lane-build PR via tasks.md acceptance, not this _plan commit.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
