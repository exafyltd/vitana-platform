# Sparring round 2 — converged

Session: `89610500-8153-4f3d-a268-9edaa3ec8d3d` · plan hash `511e606804267aa1ced1dd00907627d15889fb6a9295179b787f99f83abdbc58`

## Summary

Round 2 review of the revised plan. All three previous findings were properly addressed: R1-F1's rejection is sound (verified the three extra workflows contain no staging key references), R1-F2's line references are corrected, and R1-F3's drift-role separation is well-designed. The revised plan is thorough and internally consistent. I found one minor citation error but no blockers or major issues.

## Findings

### R2-F1 [minor]

The plan §6 oidc-roles test description says the script 'reads group-inherited policies (list-groups-for-user, list-attached-group-policies, list-group-policies) and the user's permissions boundary (sparring R1-F2)'. R1-F2 was about correcting line references (:143-144 → :144-145), not about group-inherited policies or permissions boundaries. This requirement is inherent to §3's interface definition (which says 'its attached managed and inline policies AND those of every IAM group it belongs to') and was partially motivated by R1-F3 (verifying whether the staging user carries production data-plane access). The citation is misattributed.

- `exafyltd/vitana-platform:.github/workflows/MIGRATION-DRIFT-CHECK.yml:144` — SECRET_ARN=$(aws rds describe-db-clusters --region $R --db-cluster-identifier vitana-aurora-prod \
              --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)

Suggestion: Change '(sparring R1-F2)' to '(sparring R1-F3)' or remove the attribution entirely, since the group-policy enumeration is a direct consequence of §3's interface spec.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Rejection is sound. Verified at the pinned commit: AWS-STAGING-VALIDATION.yml uses no AWS credentials at all, and both AWS-OPS-ECS-SCALE-UNGOVERNED.yml and AWS-REHEARSAL-AURORA-CLONE.yml use OIDC with secrets.AWS_PROD_ROLE_ARN, not the staging static keys. The plan's inventory of eight vitana-platform files is complete.
- R1-F2: acknowledged — Accepted and addressed. Line references in §2 now read :144-145 and :148-150, matching the actual file.
- R1-F3: acknowledged — Accepted and well addressed. The plan creates vitana-gha-drift-readonly with narrow read-only permissions (rds-data:ExecuteStatement, secretsmanager on claude-readonly only), assigns it to both ALERT-APP-USERS-IDENTITY-DRIFT.yml and MIGRATION-DRIFT-CHECK.yml's aurora branch, and documents the risk that the staging role may inherit production data-plane permissions in §9 with narrowing deferred to Phase 3.
