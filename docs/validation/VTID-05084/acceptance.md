# VTID-05084 — loop catalog covers AWS-KIRO-ACCESS (main fix)

AC-01 — every scheduled workflow has exactly one owning loop; AWS-KIRO-ACCESS.yml (VTID-05764, #5027) is owned by L5 Guard.
TEST: services/gateway/test/loop-catalog.test.ts (coverage rule, 25 of 25)

AC-02 — no other change: the catalog differs from main by one added workflow name.
TEST: git diff origin/main -- services/gateway/specs/loop-catalog-v1.json (one line)

Evidence: outputs/jest-loop-catalog.txt. Commands: commands.log.
Staging: none. Catalog metadata only; no runtime change.
