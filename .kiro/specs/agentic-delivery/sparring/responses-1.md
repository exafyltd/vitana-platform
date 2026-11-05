# Responses — round 1 (session `b80e315e-68b7-4e3b-ae79-d876722af78c`)

Each finding was checked against the base ref before answering. R1-F1 and R1-F2 change the plan; R1-F3 is a
pre-existing gap whose fix belongs to T5. While answering I also found a defect the round did not raise (the atlas drift
guard); a new lane `prerequisites` fixes it, described at the end.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed: DEPLOY-CLOUDFLARE-WORKERS.yml:12-17 runs on a push to main that changes cloudflare/** (or the workflow file) and deploys production Workers with no PUBLISH. That is how it works today, and after the cut the GitLab push mirror's push of main starts it exactly as a merge on GitHub does now. The plan's principle 5 was worded as if no such path existed, which was wrong. Changes: §3.1 principle 5 now names this as the one pre-existing exception and says the cut adds no other way for a landing to reach production; the §2.2 row cites the path filter; §4 has a new row 'Cloudflare Workers deploy' (today / from the cut / what stays); lane cutover's test github-workflows.test.mjs (in its own paths, tasks.md C1) fails if any other kept workflow that a push to main starts deploys production; the cut checklist (§8.1) has that test as an item; owner decision C2 is reworded as 'whether DEPLOY-CLOUDFLARE-WORKERS moves under PUBLISH (until then it deploys as it does today)'. I did not choose option (a), disabling it at the cut: that would stop Workers deploys until T5 exists, a change of production behaviour that this delivery plan has no mandate for. Keeping today's behaviour is the conservative option, and the owner can change it at any time with C2."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Confirmed: record-oasis.sh:40 (and the crashed-runner body further down) hard-codes workflow: \"STAGING-VERIFY.yml\", so GitLab rows would claim a GitHub workflow. Since the VTID ledger and OASIS are the record of all work (§3.11), provenance matters. Change: record-oasis.sh reads WORKFLOW with the default STAGING-VERIFY.yml, so GitHub runs write a byte-identical body; the GitLab .record job passes gitlab:<project>/staging-verify (§3.6 step 4, §3.11 Writers). The PUBLISH gate filters on topic, service and commit (publish-gate.ts:135), none of which changes. Lane files cannot be edited in a plan PR after their first commit, and record-oasis.sh is outside lane verify-on-gitlab's paths, so the change goes to a new lane prerequisites (tasks.md, lanes/prerequisites.md), with a test that runs the script against a fake curl and proves the default body is unchanged; verify-on-gitlab's record-env test now expects the body to differ only in metadata.workflow."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "deferred",
    "rationale": "Confirmed as a pre-existing gap: operator.ts:2326-2348 dispatches AWS-PROD-DEPLOY-FRONTEND.yml on vitana-v1 main with only a reason, so the frontend is rebuilt from whatever main is when the job checks out. The cut widens the window by the push mirror's lag of up to a minute. The fix is a pinned frontend promotion, which is what T5 (promote by digest) does; a separate pin on the GitHub workflow now would mean editing AWS-PROD-DEPLOY-FRONTEND.yml, a protected gate file, for a few days of value. Plan changes: §8.5 step 2 says T5 also pins the frontend to the verified commit and cites the current lines; new risk R12 records the gap, the wider window, and the mitigation until T5: the Delivery screen shows the frontend commit staging verified next to GitHub's main, so a difference is visible before PUBLISH.",
    "deferred_to": "plan §8.5 step 2 (T5, promote by digest, the first plan after the cut)"
  }
]
```

## Found while answering: the atlas drift guard
`services/gateway/test/vtid-04560-role-separation-regression.test.ts:524-528` fails when a file under
`services/gateway/src/routes/` is claimed by no domain of `services/gateway/src/orb/developer/domain-atlas.ts`
(`domainsForRoute`, `domain-atlas.ts:223-226`). No domain claims `delivery` (this plan's `routes/delivery.ts`, lane
`gateway-delivery`) or `internal-gitlab-webhook` (eng-gitlab-m2 lane `scm-webhook`), and neither lane has
`domain-atlas.ts` in its paths. New lane `prerequisites` adds both claims to the domain `deploy`
(`domain-atlas.ts:84-88`, "Deploys, CI/CD and the Command Hub") and lands first; plan §9 states the order, because lane
files can name only lanes of the same plan.
