```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Accepted on its operative half and corrected on its sub-claim. OPERATIVE (accepted): vitana-v1 was not pinned in this session, so the code-level premises could not be verified — correct. Root cause confirmed in code: spar_refs is applied only at client.create (scripts/collab/plan-spar.mjs:312-320); client.round (:333) forwards no extra_refs, and the round-1 session was created before spar_refs reached the branch, so the gateway session carries no vitana-v1 binding. SUB-CLAIM (rejected with citation): the assertion that `spar_refs: - exafyltd/vitana-v1: main` is a 'loud declaration error' because cross-repo refs must be a verbatim 40-hex SHA is FALSE against the shipped code. resolveRef (scripts/collab/plan-spar.mjs:80-83) returns the ref unchanged only when SHA40.test(ref) is true, and otherwise fetches https://api.github.com/repos/{repo}/commits/{ref} to resolve a branch/tag (e.g. `main`) to a concrete SHA. The SHA-only, branch-resolution-deferred wording the finding cites lives in the OLDER design note plan-spar-vitana-v1-ref/plan.md:89, which was superseded by that implementation; `main` is a valid, functional declaration and is exactly what the sibling native-wave2-home-feed-news used to converge. So the declaration is correct; the effective fix for THIS session is still a fresh client.create via the replan path, which this plan-text change sets up.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Genuine defect — fixed in plan.md. The plan instructed vendoring the N5a Health Sync entry signature from 'the open green vitana-v1 #1398 branch (readable even though unmerged)', but n5a-health-sync.md:16-19 records #1398 as already main-merged on 2026-10-14 (8fea5e652); the open work is re-vendoring the ingest CONTRACT from C1's (#4107) merge commit, blocked on the d10-consents migration. The plan conflated the merged module code with the not-yet-re-vendored contract types and named a branch that is no longer the live source. Fix: the plan now vendors the signature from the N5a export AS LANDED ON vitana-v1 main (8fea5e652), to be verified against the live file in the fresh vitana-v1-pinned session, and re-targets the follow-up task to re-pin the vendored signature to C1's merge commit once C1 lands. The contract-test mechanism (type-level assignability + runtime shape check, failing NATIVE-CI on drift) is unchanged; only the signature source is corrected.",
    "deferred_to": ""
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Accepted as the consequence of R1-F1: the three load-bearing premises carried forward (F2 src/lib/vitanaIndex.ts IO-freedom for the Decision-2 core extraction; F3 the 4+4+16=24 ledger partition with 0 overlap / 0 orphan; F4 the no-health-data claim for Plans.tsx and WellnessServices.tsx that lets health-plans-services build in parallel with health-hub) all remain independently unverified while the partner is blind. These are exactly the reads the fresh, vitana-v1-pinned session must perform and cite line-level in the Measured state block: read src/lib/vitanaIndex.ts tracing every runtime import transitively (confirm class A, no @/integrations/supabase/client reach, else core-closure --check fails at m.own !== 'A'); enumerate the 24 lane===health rows by id in apps/mobile/parity/ledger.json; read Plans.tsx and WellnessServices.tsx tracing every hook import (if either reaches a class-B health-data hook, health-plans-services must take depends_on:[health-hub] and drop the parallel claim). The plan's classification stands as the hypothesis the fresh session verifies.",
    "deferred_to": "fresh vitana-v1-pinned sparring session (replan branch); flagged for owner/operator if replan does not auto-fire"
  }
]
```
