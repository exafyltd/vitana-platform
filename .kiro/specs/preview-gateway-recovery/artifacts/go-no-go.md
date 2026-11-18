# Go / no-go before the first VTID insert (preview-gateway-recovery)

Each line is evidence, not intent. A NO on any line means no insert.

## Already done (evidence in artifacts/)
- [x] Aurora staging restore applied 13:56 UTC, pinned commit 9fa0d390 (apply-2026-11-18T1356Z.txt)
- [x] PostgREST proxy on revision 24, bound to postgrest-jwt-secret-WiEKX3, staging key 200 / production key 401 (proxy-rev24-2026-11-18.txt)
- [x] Preview IAM roles: task role (Bedrock only), execution role (six secrets only)
- [x] Staging-only secrets: postgrest-service-role-key, preview-sparring-token (values never printed)
- [x] Operator: arn:aws:iam::472838866351:user/j.tadic@vitanaland.com (AdministratorAccess, MFA on); not root
- [x] Transfer bucket vitana-recovery-transfer-472838866351 kept until recovery acceptance
- [x] PLAN-SPAR token patch (artifacts/plan-spar-token.patch) applies cleanly to origin/main d8b8a8c5e0

## Owner decisions (only the owner can give these)
- [ ] Rule 55 confirmed by the rule owner: one covering recovery sparring verdict attaches to both VTIDs; 24 h clock starts at the first insert
- [ ] Written go for the two inserts, with the time they are made

## #5110 (runtime-profile) must be mergeable (blockers found 2026-11-18)
- [ ] Rebased onto current main (its base is 67897e6c; main is now d8b8a8c5e0)
- [ ] Title carries the VTID (currently "[NO VTID - awaiting plan sparring]")
- [ ] docs/validation/<VTID>/staging-tests.json added (CI change-suite fails: CLAUDE.md rule 47)
- [ ] validate-pr green (currently exit 10; the VTID title and suite cover it)
- [ ] Undrafted; reviewer-agent accept (vitana-lane-reviewer) on the current head
- [ ] Merge through §7b; auto-build pushes vitana/gateway:<sha12> to ECR

## PLAN-SPAR token change (protected: .github/workflows/PLAN-SPAR.yml)
- [ ] Lane branch kiro/preview-gateway-recovery/plan-spar-token rebased on the current main
- [ ] Owner instruction naming preview-gateway-recovery (on record, 2026-11-18)
- [ ] Reviewer-agent accept on the PR's current head
- [ ] VTID in its commit/title

## Preview deployment (after #5110 is merged)
- [ ] preview-gateway.sh plan --commit <merge sha> refuses nothing and prints the live routing report
- [ ] Routing report shows build-info, health, orb ws and vtid/allocate on the preview host stay on rule 10
- [ ] Rollback state will be written by apply (restore file for preview-gateway.sh rollback)

## Covering verdict and VTIDs
- [ ] runtime-profile and plan-spar-token allocated by the owner through the exemption role
- [ ] Each VTID record carries metadata.sparring_exempt_reason (the reconciler's 24 h follow-up)
- [ ] Covering sparring: PLAN-SPAR on plan(preview-gateway-recovery) after plan-spar-token is on main; PLAN_SPAR_ALLOCATE forced false by the token change; verdict and run link attached to both VTIDs
- [ ] Emoji #5117 run is separate: triggered only after the preview is deployed and the covering run has a verdict
